import { Router, type IRouter } from "express";
import { db, leadsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  searchPeople,
  matchPerson,
  isConfigured as apolloConfigured,
  type ApolloPerson,
} from "../integrations/apollo";
import { generateUnsubscribeToken } from "../pipeline/lcap";

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
router.get("/sources", (_req, res): void => {
  res.json({
    apollo: { configured: apolloConfigured() },
    csv: { configured: true },
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
