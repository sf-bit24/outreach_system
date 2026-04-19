import { Router, type IRouter } from "express";
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
    .select({ id: scrapingCredentialsTable.id })
    .from(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, "apollo"))
    .limit(1);
  const [linkedinCreds] = await db
    .select({ id: scrapingCredentialsTable.id })
    .from(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, "linkedin"))
    .limit(1);
  res.json({
    apollo: { configured: apolloConfigured() },
    csv: { configured: true },
    apolloScraper: { configured: !!apolloCreds },
    linkedinScraper: { configured: !!linkedinCreds },
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
      .set({ encryptedPayload: payload, label, lastError: null })
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
  if (provider !== "apollo" && provider !== "linkedin") {
    res.status(400).json({ error: "provider must be 'apollo' or 'linkedin'" });
    return;
  }
  const params = {
    keywords: asString(body["keywords"]),
    jobTitles: asStringArray(body["jobTitles"]),
    locations: asStringArray(body["locations"]),
    perPage: asInt(body["perPage"]),
    maxPages: asInt(body["maxPages"]),
    maxResults: asInt(body["maxResults"]),
  };

  // Verify credentials exist before queueing
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
  const usage: Record<string, number> = { apollo: 0, linkedin: 0 };
  for (const r of rows) usage[r.provider] = Number(r.total);
  res.json({
    apollo: { used: usage.apollo, limit: 200 },
    linkedin: { used: usage.linkedin, limit: 100 },
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

export default router;
