import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { db, leadsTable } from "@workspace/db";
import {
  scrapingCredentialsTable,
  scrapingJobsTable,
} from "@workspace/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  searchPeople,
  matchPerson,
  isConfigured as apolloConfigured,
  type ApolloPerson,
} from "../integrations/apollo";
import { generateUnsubscribeToken } from "../pipeline/lcap";
import { encryptJson } from "../scraping/crypto";
import { runJobInBackground } from "../scraping/jobRunner";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 350 * 1024 * 1024 },
});

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return arr.length > 0 ? arr : undefined;
}
function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

/** GET /api/sources — capability flags for UI */
router.get("/sources", async (_req, res): Promise<void> => {
  const [apolloCreds] = await db
    .select({ id: scrapingCredentialsTable.id, status: scrapingCredentialsTable.status, lastError: scrapingCredentialsTable.lastError })
    .from(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, "apollo"))
    .orderBy(sql`${scrapingCredentialsTable.id} DESC`)
    .limit(1);
  const [linkedinCreds] = await db
    .select({ id: scrapingCredentialsTable.id, status: scrapingCredentialsTable.status, lastError: scrapingCredentialsTable.lastError })
    .from(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, "linkedin"))
    .orderBy(sql`${scrapingCredentialsTable.id} DESC`)
    .limit(1);
  // Three-state credential status: "absent" (no row), "active", "expired".
  const credStatus = (row: typeof apolloCreds | undefined) =>
    !row ? "absent" : row.status;
  res.json({
    apollo: { configured: apolloConfigured() },
    csv: { configured: true },
    apolloScraper: {
      configured: !!apolloCreds,
      status: credStatus(apolloCreds),
      lastError: apolloCreds?.lastError ?? null,
    },
    linkedinScraper: {
      configured: !!linkedinCreds,
      status: credStatus(linkedinCreds),
      lastError: linkedinCreds?.lastError ?? null,
    },
    // Google Maps scrapes public listings — no login required, so it's
    // always "ready" as long as the worker can launch a browser.
    gmapsScraper: { configured: true, status: "active", lastError: null },
  });
});

/* ────────────────────── SCRAPER CREDENTIALS ────────────────────── */

interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

function parseCookies(raw: unknown, defaultDomain: string): CookieInput[] {
  // Accept either: array of cookie objects, or a "Cookie:" header string,
  // or a JSON exported from a browser extension like "EditThisCookie".
  if (Array.isArray(raw)) {
    return raw
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
      .map((c) => ({
        name: String(c["name"] ?? ""),
        value: String(c["value"] ?? ""),
        domain: String(c["domain"] ?? defaultDomain),
        path: typeof c["path"] === "string" ? c["path"] : "/",
        expires: typeof c["expirationDate"] === "number"
          ? c["expirationDate"]
          : typeof c["expires"] === "number"
          ? c["expires"]
          : undefined,
        httpOnly: typeof c["httpOnly"] === "boolean" ? c["httpOnly"] : false,
        secure: typeof c["secure"] === "boolean" ? c["secure"] : true,
        sameSite:
          c["sameSite"] === "Lax" || c["sameSite"] === "Strict" || c["sameSite"] === "None"
            ? (c["sameSite"] as "Lax" | "Strict" | "None")
            : "Lax",
      }))
      .filter((c) => c.name && c.value);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    // try JSON first
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseCookies(parsed, defaultDomain);
    } catch {
      /* fall through */
    }
    // Fallback: parse a Cookie header string "k1=v1; k2=v2"
    return raw
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p): CookieInput | null => {
        const idx = p.indexOf("=");
        if (idx < 0) return null;
        const name = p.slice(0, idx).trim();
        const value = p.slice(idx + 1).trim();
        if (!name || !value) return null;
        return {
          name,
          value,
          domain: defaultDomain,
          path: "/",
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        };
      })
      .filter((c): c is CookieInput => c !== null);
  }
  return [];
}

router.post("/sources/scraper/credentials", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const provider = body["provider"];
  if (provider !== "apollo" && provider !== "linkedin") {
    res.status(400).json({ error: "provider must be 'apollo' or 'linkedin'" });
    return;
  }
  const defaultDomain =
    provider === "apollo" ? ".apollo.io" : ".linkedin.com";
  const cookies = parseCookies(body["cookies"], defaultDomain);
  if (cookies.length === 0) {
    res.status(400).json({ error: "No valid cookies parsed from input" });
    return;
  }
  // For LinkedIn, the critical cookie is `li_at` — warn if missing
  if (provider === "linkedin" && !cookies.some((c) => c.name === "li_at")) {
    res.status(400).json({
      error: "LinkedIn cookie 'li_at' is required. Export your full cookie set while logged in.",
    });
    return;
  }
  const userAgent = asString(body["userAgent"]);
  const label = asString(body["label"]);
  const payload = encryptJson({ cookies, userAgent, label });

  const existing = await db
    .select({ id: scrapingCredentialsTable.id })
    .from(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, provider))
    .limit(1);

  if (existing[0]) {
    await db
      .update(scrapingCredentialsTable)
      .set({
        encryptedPayload: payload,
        label,
        // Re-imported cookies must reset the lifecycle: clear any previous
        // expired/error state so the worker accepts them again.
        status: "active",
        lastError: null,
        lastValidatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(scrapingCredentialsTable.id, existing[0].id));
    res.json({ id: existing[0].id, provider, updated: true });
    return;
  }
  const [row] = await db
    .insert(scrapingCredentialsTable)
    .values({ provider, label, encryptedPayload: payload })
    .returning({ id: scrapingCredentialsTable.id });
  res.status(201).json({ id: row?.id, provider, updated: false });
});

router.delete("/sources/scraper/credentials/:provider", async (req, res): Promise<void> => {
  const provider = req.params.provider;
  if (provider !== "apollo" && provider !== "linkedin") {
    res.status(400).json({ error: "invalid provider" });
    return;
  }
  await db
    .delete(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, provider));
  res.status(204).end();
});

/* ────────────────────── SCRAPER JOBS ────────────────────── */

router.post("/sources/scraper/jobs", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const provider = body["provider"];
  if (provider !== "apollo" && provider !== "linkedin" && provider !== "gmaps") {
    res.status(400).json({
      error: "provider must be 'apollo', 'linkedin' or 'gmaps'",
    });
    return;
  }
  const params =
    provider === "gmaps"
      ? {
          category: asString(body["category"]),
          city: asString(body["city"]),
          radiusKm: asInt(body["radiusKm"]),
          maxResults: asInt(body["maxResults"]),
        }
      : {
          keywords: asString(body["keywords"]),
          jobTitles: asStringArray(body["jobTitles"]),
          locations: asStringArray(body["locations"]),
          perPage: asInt(body["perPage"]),
          maxPages: asInt(body["maxPages"]),
          maxResults: asInt(body["maxResults"]),
        };

  if (provider === "gmaps") {
    // Sanity-check: at least a category or city is required so we don't
    // launch a browser to scrape "everything".
    const p = params as { category?: string; city?: string };
    if (!p.category && !p.city) {
      res.status(400).json({
        error: "Au moins une catégorie ou une ville est requise pour Google Maps",
      });
      return;
    }
  } else {
    // Verify credentials exist before queueing for cookie-based providers
    const [creds] = await db
      .select({ id: scrapingCredentialsTable.id })
      .from(scrapingCredentialsTable)
      .where(eq(scrapingCredentialsTable.provider, provider))
      .limit(1);
    if (!creds) {
      res.status(400).json({
        error: `No ${provider} session cookies configured. Import them first.`,
      });
      return;
    }
  }

  const [job] = await db
    .insert(scrapingJobsTable)
    .values({ provider, params, status: "queued" })
    .returning();
  if (!job) {
    res.status(500).json({ error: "Failed to create job" });
    return;
  }
  runJobInBackground(job.id);
  res.status(201).json(job);
});

router.get("/sources/scraper/jobs", async (_req, res): Promise<void> => {
  const jobs = await db
    .select()
    .from(scrapingJobsTable)
    .orderBy(desc(scrapingJobsTable.id))
    .limit(20);
  res.json(jobs);
});

router.get("/sources/scraper/jobs/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [job] = await db
    .select()
    .from(scrapingJobsTable)
    .where(eq(scrapingJobsTable.id, id))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(job);
});

/** Aggregate hourly usage per provider for the rate-limit UI badge. */
router.get("/sources/scraper/usage", async (_req, res): Promise<void> => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await db
    .select({
      provider: scrapingJobsTable.provider,
      total: sql<number>`coalesce(sum(${scrapingJobsTable.itemsScraped}), 0)::int`,
    })
    .from(scrapingJobsTable)
    .where(sql`${scrapingJobsTable.startedAt} >= ${oneHourAgo}`)
    .groupBy(scrapingJobsTable.provider);
  const usage: Record<string, number> = { apollo: 0, linkedin: 0, gmaps: 0 };
  for (const r of rows) usage[r.provider] = Number(r.total);
  res.json({
    apollo: { used: usage.apollo, limit: 200 },
    linkedin: { used: usage.linkedin, limit: 100 },
    gmaps: { used: usage.gmaps, limit: 150 },
    windowMinutes: 60,
  });
});

/* ────────────────────────── APOLLO ────────────────────────── */

router.post("/sources/apollo/search", async (req, res): Promise<void> => {
  if (!apolloConfigured()) {
    res.status(400).json({ error: "Apollo not configured (APOLLO_API_KEY missing)" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const input = {
    keywords: asString(body["keywords"]),
    jobTitles: asStringArray(body["jobTitles"]),
    locations: asStringArray(body["locations"]),
    companyName: asString(body["companyName"]),
    page: asInt(body["page"]),
    perPage: asInt(body["perPage"]),
  };

  try {
    const result = await searchPeople(input);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Apollo search failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Apollo search failed",
    });
  }
});

router.post("/sources/apollo/import", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { people?: unknown; campaignId?: unknown };
  if (!Array.isArray(body.people)) {
    res.status(400).json({ error: "people must be an array" });
    return;
  }
  const campaignId = asInt(body.campaignId) ?? null;
  const people = body.people as ApolloPerson[];

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const p of people) {
    if (!p.email) {
      skipped++;
      continue; // can't insert without email (NOT NULL)
    }
    if (!p.firstName || !p.lastName || !p.company || !p.jobTitle) {
      skipped++;
      continue;
    }
    try {
      const [inserted] = await db
        .insert(leadsTable)
        .values({
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email.toLowerCase().trim(),
          company: p.company,
          jobTitle: p.jobTitle,
          website: p.website ?? null,
          linkedinUrl: p.linkedinUrl ?? null,
          industry: p.industry ?? null,
          location: p.location ?? null,
          companySize: p.companySize ?? null,
          campaignId,
          unsubscribeToken: generateUnsubscribeToken(),
          source: "apollo_api",
          // Apollo-supplied emails are not pre-verified by us — they go through
          // enrichment before sending. emailLocked stays false because the
          // address itself is visible (not masked); the sender guard blocks
          // them via emailStatus until enrichment marks them "verified".
          emailStatus: "scraped",
          emailLocked: false,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) imported++;
      else skipped++;
    } catch (err) {
      errors.push(`${p.email}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors });
});

router.post("/sources/apollo/match", async (req, res): Promise<void> => {
  if (!apolloConfigured()) {
    res.status(400).json({ error: "Apollo not configured" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const input = {
    firstName: asString(body["firstName"]),
    lastName: asString(body["lastName"]),
    email: asString(body["email"]),
    organizationName: asString(body["organizationName"]),
    domain: asString(body["domain"]),
    linkedinUrl: asString(body["linkedinUrl"]),
  };
  if (!input.email && !input.linkedinUrl && !(input.firstName && input.lastName)) {
    res.status(400).json({
      error: "Fournissez au moins un email, une URL LinkedIn, ou (prénom + nom + entreprise)",
    });
    return;
  }

  try {
    const person = await matchPerson(input);
    res.json({ person });
  } catch (err) {
    logger.error({ err }, "Apollo match failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Apollo match failed",
    });
  }
});

/* ────────────────────────── CSV IMPORT ────────────────────────── */

/** Lightweight CSV parser — handles quoted fields with commas and escaped quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        cur.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        cur.push(field);
        field = "";
        if (cur.some((f) => f.length > 0)) lines.push(cur);
        cur = [];
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    if (cur.some((f) => f.length > 0)) lines.push(cur);
  }
  if (lines.length < 2) return [];
  const headers = lines[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (row[i] ?? "").trim();
    });
    return obj;
  });
}

const HEADER_ALIASES: Record<string, string[]> = {
  firstName: ["first_name", "firstname", "prenom", "prénom", "first"],
  lastName: ["last_name", "lastname", "nom", "last", "surname"],
  email: ["email", "courriel", "e-mail", "mail"],
  company: ["company", "entreprise", "organization", "organisation", "company_name"],
  jobTitle: ["job_title", "title", "titre", "poste", "position"],
  website: ["website", "site", "site_web", "url", "company_website"],
  linkedinUrl: ["linkedin", "linkedin_url", "linkedin_profile"],
  phone: ["phone", "telephone", "téléphone", "tel"],
  industry: ["industry", "industrie", "secteur"],
  companySize: ["company_size", "size", "taille"],
  location: ["location", "city", "ville", "lieu", "address"],
};

function pick(row: Record<string, string>, field: keyof typeof HEADER_ALIASES): string {
  for (const alias of HEADER_ALIASES[field]!) {
    if (row[alias] && row[alias]!.length > 0) return row[alias]!;
  }
  return "";
}

router.post("/sources/csv/import", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { csv?: unknown; campaignId?: unknown };
  if (typeof body.csv !== "string" || body.csv.length === 0) {
    res.status(400).json({ error: "csv (string) is required" });
    return;
  }
  const campaignId = asInt(body.campaignId) ?? null;

  const rows = parseCsv(body.csv);
  if (rows.length === 0) {
    res.status(400).json({ error: "CSV vide ou en-têtes manquants" });
    return;
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const firstName = pick(row, "firstName");
    const lastName = pick(row, "lastName");
    const email = pick(row, "email").toLowerCase();
    const company = pick(row, "company");
    const jobTitle = pick(row, "jobTitle");

    if (!firstName || !lastName || !email || !company || !jobTitle) {
      skipped++;
      errors.push(
        `Ligne incomplète (email=${email || "?"}): champs requis manquants (prénom, nom, email, entreprise, poste)`,
      );
      continue;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped++;
      errors.push(`Email invalide: ${email}`);
      continue;
    }

    try {
      const [inserted] = await db
        .insert(leadsTable)
        .values({
          firstName,
          lastName,
          email,
          company,
          jobTitle,
          website: pick(row, "website") || null,
          linkedinUrl: pick(row, "linkedinUrl") || null,
          phone: pick(row, "phone") || null,
          industry: pick(row, "industry") || null,
          companySize: pick(row, "companySize") || null,
          location: pick(row, "location") || null,
          campaignId,
          unsubscribeToken: generateUnsubscribeToken(),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) imported++;
      else skipped++;
    } catch (err) {
      errors.push(`${email}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors: errors.slice(0, 50) });
});

/* ────────────────────── ASFC CUSTOMS BROKERS ────────────────────── */

const ASFC_URL =
  "https://www.cbsa-asfc.gc.ca/services/cb-cd/cb-cd-fra.html";

/**
 * Parse the CBSA/ASFC customs-broker HTML page.
 * The page contains a single <table> with three columns:
 *   Nom | Site Web | Adresse courriel
 * Both website and email cells may contain an <a> tag or the literal "Sans objet".
 */
async function fetchAsfcLeads(): Promise<
  Array<{ company: string; website: string | null; email: string | null }>
> {
  const cheerio = await import("cheerio");
  const response = await fetch(ASFC_URL, {
    headers: {
      "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.5",
      "User-Agent":
        "Mozilla/5.0 (compatible; OutreachIQ-Importer/1.0; +https://outreachiq.local)",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} depuis l'ASFC`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);
  const results: Array<{ company: string; website: string | null; email: string | null }> = [];

  $("table tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const company = $(cells[0]).text().replace(/\s+/g, " ").trim();
    if (!company) return;

    const websiteAnchor = $(cells[1]).find("a").first();
    const website = websiteAnchor.length ? (websiteAnchor.attr("href") ?? null) : null;

    const emailAnchor = $(cells[2]).find("a[href^='mailto:']").first();
    let email: string | null = null;
    if (emailAnchor.length) {
      const raw = emailAnchor.attr("href")?.replace(/^mailto:/i, "").trim() ?? "";
      email = raw.length > 0 ? raw.toLowerCase() : null;
    }

    results.push({ company, website, email });
  });

  return results;
}

/** POST /api/sources/asfc/import — import all CBSA-licensed customs brokers */
router.post("/sources/asfc/import", async (req, res): Promise<void> => {
  let rows: Awaited<ReturnType<typeof fetchAsfcLeads>>;
  try {
    rows = await fetchAsfcLeads();
  } catch (err) {
    req.log.error({ err }, "ASFC fetch failed");
    res.status(502).json({
      error: `Impossible de télécharger la liste ASFC : ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (rows.length === 0) {
    res.status(502).json({ error: "La page ASFC n'a retourné aucune donnée — structure peut-être modifiée." });
    return;
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.email) {
      skipped++;
      continue;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
      skipped++;
      errors.push(`Email invalide ignoré : ${row.email} (${row.company})`);
      continue;
    }

    try {
      const [inserted] = await db
        .insert(leadsTable)
        .values({
          firstName: "Contact",
          lastName: row.company.slice(0, 100),
          email: row.email,
          company: row.company,
          jobTitle: "Courtier en douane agréé",
          website: row.website ?? null,
          industry: "Douanes & Logistique",
          source: "asfc",
          sourceUrl: ASFC_URL,
          emailStatus: "scraped",
          emailLocked: false,
          unsubscribeToken: generateUnsubscribeToken(),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) imported++;
      else skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${row.email}: ${msg}`);
      skipped++;
    }
  }

  req.log.info({ imported, skipped }, "ASFC import complete");
  res.json({ imported, skipped, total: rows.length, errors: errors.slice(0, 50) });
});

// ─── REQ — Registre des entreprises du Québec ───────────────────────────────

function parseReqCsv(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return [];

  const raw = lines[0];
  const sep = raw.includes(";") ? ";" : ",";
  const headers = raw.split(sep).map((h) => h.trim().replace(/^"|"$/g, "").toUpperCase());

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitCsvLine(line, sep);
    if (cells.length === 0) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? "").replace(/^"|"$/g, "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === sep && !inQuote) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function pick2(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k] ?? row[k.toLowerCase()];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

router.post(
  "/sources/req/import",
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Fichier ZIP requis (champ : file)" });
      return;
    }

    const maxLeads = Number(req.body?.maxLeads) || 0;

    let zip: AdmZip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch {
      res.status(400).json({ error: "Fichier ZIP invalide ou corrompu" });
      return;
    }

    const entry =
      zip.getEntry("Entreprise.csv") ??
      zip.getEntry("entreprise.csv") ??
      zip.getEntries().find(
        (e) => e.entryName.toLowerCase().endsWith("entreprise.csv"),
      );

    if (!entry) {
      const names = zip
        .getEntries()
        .slice(0, 20)
        .map((e) => e.entryName)
        .join(", ");
      res.status(400).json({
        error: `Fichier Entreprise.csv introuvable dans le ZIP. Fichiers trouvés : ${names}`,
      });
      return;
    }

    const csvContent = entry.getData().toString("utf-8");
    const rows = parseReqCsv(csvContent);

    if (rows.length === 0) {
      res.status(400).json({ error: "Entreprise.csv vide ou format non reconnu" });
      return;
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const slice = maxLeads > 0 ? rows.slice(0, maxLeads) : rows;

    for (const row of slice) {
      const etat = pick2(row, "ETAT_IMMAT", "ETAT_IMMATRICULATION", "STATUT");
      if (etat && etat.toUpperCase() !== "IMMAT") {
        skipped++;
        continue;
      }

      const companyName =
        pick2(row, "NOM_PERS_MORALE", "NOM_COMM", "NOM_ENTR", "NOM") ||
        pick2(row, "NAME");
      if (!companyName) {
        skipped++;
        continue;
      }

      const neq = pick2(row, "NEQ", "NO_NEQ", "NEQ_ENTR");
      const city = pick2(row, "ADR_DOMICILE_VILLE", "VILLE", "MUNICIPALITE");
      const province = pick2(row, "ADR_DOMICILE_PROVINCE", "PROVINCE") || "QC";
      const website = pick2(row, "SITE_INTERNET", "SITE_WEB", "URL");
      const location = [city, province].filter(Boolean).join(", ");

      try {
        const [inserted] = await db
          .insert(leadsTable)
          .values({
            firstName: companyName.slice(0, 255),
            lastName: neq ? `(NEQ ${neq})` : "",
            email: null,
            company: companyName.slice(0, 255),
            jobTitle: "Entreprise (REQ)",
            website: website || null,
            location: location || null,
            industry: "REQ — Registre des entreprises",
            source: "req",
            emailStatus: "needs_enrichment",
            emailLocked: false,
            unsubscribeToken: generateUnsubscribeToken(),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) imported++;
        else skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (errors.length < 50) errors.push(`${companyName}: ${msg}`);
        skipped++;
      }
    }

    req.log.info({ imported, skipped, total: slice.length }, "REQ import complete");
    res.json({ imported, skipped, total: slice.length, errors });
  },
);

export default router;
