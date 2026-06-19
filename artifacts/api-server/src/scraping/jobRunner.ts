import { db } from "@workspace/db";
import {
  scrapingJobsTable,
  scrapingCredentialsTable,
  leadsTable,
  type ScrapingJob,
} from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { decryptJson } from "./crypto";
import {
  scrapeApollo,
  type ScrapedApolloPerson,
  type ApolloSearchParams,
} from "./apolloScraper";
import {
  scrapeLinkedIn,
  type ScrapedLinkedInPerson,
  type LinkedInSearchParams,
} from "./linkedinScraper";
import {
  scrapeGmaps,
  type ScrapedGmapsPlace,
  type GmapsSearchParams,
} from "./gmapsScraper";
import type { StoredCredentials } from "./browser";
import { enrichLead } from "../pipeline/enrich";

type Provider = "apollo" | "linkedin" | "gmaps";

const RATE_LIMITS: Record<Provider, { perHour: number }> = {
  apollo: { perHour: 200 },
  linkedin: { perHour: 100 },
  gmaps: { perHour: 150 },
};

async function loadCredentials(
  provider: "apollo" | "linkedin",
): Promise<StoredCredentials> {
  const [row] = await db
    .select()
    .from(scrapingCredentialsTable)
    .where(eq(scrapingCredentialsTable.provider, provider))
    .orderBy(sql`${scrapingCredentialsTable.id} DESC`)
    .limit(1);
  if (!row) {
    throw new Error(
      `No ${provider} credentials configured. Import your session cookies first.`,
    );
  }
  return decryptJson<StoredCredentials>(row.encryptedPayload);
}

async function checkRateLimit(provider: Provider): Promise<void> {
  const limit = RATE_LIMITS[provider];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [{ total }] = await db
    .select({ total: sql<number>`coalesce(sum(${scrapingJobsTable.itemsScraped}), 0)::int` })
    .from(scrapingJobsTable)
    .where(
      and(
        eq(scrapingJobsTable.provider, provider),
        gte(scrapingJobsTable.startedAt, oneHourAgo),
      ),
    );
  if (Number(total) >= limit.perHour) {
    throw new Error(
      `Rate limit reached for ${provider}: ${total}/${limit.perHour} items in last hour. Try again later.`,
    );
  }
}

function dedupeKey(p: {
  email?: string | null;
  linkedinUrl?: string | null;
  firstName: string;
  lastName: string;
  company?: string | null;
}): string {
  if (p.email) return `email:${p.email.toLowerCase()}`;
  if (p.linkedinUrl) return `li:${p.linkedinUrl.toLowerCase()}`;
  return `name:${p.firstName.toLowerCase()}|${p.lastName.toLowerCase()}|${(p.company ?? "").toLowerCase()}`;
}

/**
 * Look for an existing lead matching this scraped record. Tries (in order):
 * email, linkedinUrl, then (firstName + lastName + company) as a last-resort
 * fallback to keep duplicates out of the DB.
 */
async function findExistingLead(p: {
  email?: string | null;
  linkedinUrl?: string | null;
  firstName: string;
  lastName: string;
  company?: string | null;
}): Promise<{ id: number } | null> {
  if (p.email) {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.email, p.email.toLowerCase()))
      .limit(1);
    if (row) return row;
  }
  if (p.linkedinUrl) {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.linkedinUrl, p.linkedinUrl))
      .limit(1);
    if (row) return row;
  }
  const company = p.company ?? "";
  const [row] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.firstName, p.firstName),
        eq(leadsTable.lastName, p.lastName),
        eq(leadsTable.company, company),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function importApollo(
  _job: ScrapingJob,
  results: ScrapedApolloPerson[],
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const now = new Date();
  for (const r of results) {
    const key = dedupeKey(r);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    const existing = await findExistingLead(r);
    if (existing) {
      // Idempotent re-scrape: refresh the scraped_at marker but never
      // overwrite an existing email or status.
      await db
        .update(leadsTable)
        .set({ scrapedAt: now })
        .where(eq(leadsTable.id, existing.id));
      skipped++;
      continue;
    }
    try {
      const hasEmail = Boolean(r.email);
      await db.insert(leadsTable).values({
        firstName: r.firstName || "Unknown",
        lastName: r.lastName || "",
        // No invented emails — store NULL when Apollo masks the address.
        email: hasEmail ? r.email!.toLowerCase() : null,
        company: r.company ?? "Unknown",
        jobTitle: r.jobTitle ?? "Unknown",
        linkedinUrl: r.linkedinUrl,
        location: r.location,
        source: "apollo_scrape",
        sourceUrl: r.sourceUrl,
        // Apollo's visible emails still need our own verification before sending,
        // but they are not "locked" by Apollo. emailLocked reflects Apollo's
        // own masking only.
        emailStatus: hasEmail ? "scraped" : "locked",
        emailLocked: !hasEmail,
        scrapedAt: now,
      });
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

async function importLinkedIn(
  _job: ScrapingJob,
  results: ScrapedLinkedInPerson[],
): Promise<{ imported: number; skipped: number; insertedIds: number[] }> {
  let imported = 0;
  let skipped = 0;
  const insertedIds: number[] = [];
  const seen = new Set<string>();
  const now = new Date();
  for (const r of results) {
    const key = dedupeKey(r);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    if (!r.linkedinUrl) {
      skipped++;
      continue;
    }
    const existing = await findExistingLead(r);
    if (existing) {
      await db
        .update(leadsTable)
        .set({ scrapedAt: now })
        .where(eq(leadsTable.id, existing.id));
      skipped++;
      continue;
    }
    try {
      // LinkedIn search results never expose emails. Store NULL — never invent.
      const [inserted] = await db
        .insert(leadsTable)
        .values({
          firstName: r.firstName || "Unknown",
          lastName: r.lastName || "",
          email: null,
          company: r.company ?? "Unknown",
          jobTitle: r.jobTitle ?? "Unknown",
          linkedinUrl: r.linkedinUrl,
          location: r.location,
          source: "linkedin_scrape",
          sourceUrl: r.sourceUrl,
          emailStatus: "needs_enrichment",
          emailLocked: false,
          scrapedAt: now,
        })
        .returning({ id: leadsTable.id });
      if (inserted) insertedIds.push(inserted.id);
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped, insertedIds };
}

/**
 * Best-effort background enrichment for freshly-imported LinkedIn leads. Runs
 * leads one at a time (each enrichment fans out to website + SMTP probes) so we
 * don't overwhelm outbound connections. Failures are logged and never bubble up
 * to the scraping job — a lead that can't be enriched simply stays blocked.
 */
function enrichLeadsInBackground(leadIds: number[]): void {
  if (leadIds.length === 0) return;
  void (async () => {
    for (const id of leadIds) {
      try {
        await enrichLead(id);
      } catch (err) {
        console.error(`[scraping] Auto-enrichment failed for lead ${id}:`, err);
      }
    }
  })();
}

interface JobResult {
  sample:
    | ScrapedApolloPerson[]
    | ScrapedLinkedInPerson[]
    | ScrapedGmapsPlace[];
}

/**
 * Build a stable dedupe key for a Google Maps place. Google Place URLs are
 * the most reliable identifier; fall back to (name + address) for the rare
 * card without a usable href.
 */
function gmapsDedupeKey(p: { name: string; address: string | null; sourceUrl: string }): string {
  if (p.sourceUrl) return `gmaps:${p.sourceUrl}`;
  return `gmaps-name:${p.name.toLowerCase()}|${(p.address ?? "").toLowerCase()}`;
}

async function findExistingGmapsLead(p: {
  website: string | null;
  phone: string | null;
  company: string;
}): Promise<{ id: number } | null> {
  if (p.website) {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.website, p.website))
      .limit(1);
    if (row) return row;
  }
  if (p.phone) {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.phone, p.phone))
      .limit(1);
    if (row) return row;
  }
  const [row] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(eq(leadsTable.company, p.company))
    .limit(1);
  return row ?? null;
}

async function importGmaps(
  _job: ScrapingJob,
  results: ScrapedGmapsPlace[],
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const now = new Date();
  for (const r of results) {
    const key = gmapsDedupeKey(r);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    if (!r.name) {
      skipped++;
      continue;
    }
    const existing = await findExistingGmapsLead({
      website: r.website,
      phone: r.phone,
      company: r.name,
    });
    if (existing) {
      await db
        .update(leadsTable)
        .set({ scrapedAt: now })
        .where(eq(leadsTable.id, existing.id));
      skipped++;
      continue;
    }
    try {
      // When gosom finds an email on the business website (via the -email
      // flag), store it as "scraped" — visible on the site, so LCAP "bien
      // en vue" applies. The enrichment pipeline still validates it via
      // SMTP RCPT TO before marking it "verified" and allowing sends.
      // When no email was found, store NULL so the enrichment pipeline can
      // still discover one via website crawl + cascade.
      const hasEmail = Boolean(r.email);
      await db.insert(leadsTable).values({
        firstName: "—",
        lastName: r.name,
        email: hasEmail ? r.email!.toLowerCase() : null,
        company: r.name,
        jobTitle: r.category ?? "Établissement",
        website: r.website,
        phone: r.phone,
        location: r.address,
        industry: r.category,
        source: "gmaps_scrape",
        sourceUrl: r.sourceUrl,
        emailStatus: hasEmail ? "scraped" : "needs_enrichment",
        emailLocked: false,
        scrapedAt: now,
      });
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

async function executeJob(jobId: number): Promise<void> {
  const [job] = await db
    .select()
    .from(scrapingJobsTable)
    .where(eq(scrapingJobsTable.id, jobId))
    .limit(1);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== "queued") return;

  await db
    .update(scrapingJobsTable)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(scrapingJobsTable.id, jobId));

  try {
    const provider = job.provider as Provider;
    await checkRateLimit(provider);
    const params = (job.params ?? {}) as Record<string, unknown>;

    let scraped = 0;
    let imported = 0;
    let skipped = 0;
    let resultPayload: JobResult | null = null;

    if (provider === "apollo") {
      const creds = await loadCredentials(provider);
      const results = await scrapeApollo(creds, params as ApolloSearchParams);
      scraped = results.length;
      const counts = await importApollo(job, results);
      imported = counts.imported;
      skipped = counts.skipped;
      resultPayload = { sample: results.slice(0, 3) };
    } else if (provider === "linkedin") {
      const creds = await loadCredentials(provider);
      const results = await scrapeLinkedIn(
        creds,
        params as LinkedInSearchParams,
      );
      scraped = results.length;
      const counts = await importLinkedIn(job, results);
      imported = counts.imported;
      skipped = counts.skipped;
      resultPayload = { sample: results.slice(0, 3) };
      // LinkedIn leads land without an email — kick off enrichment so the
      // website-crawl + SMTP-verify pipeline can source a real address.
      enrichLeadsInBackground(counts.insertedIds);
    } else if (provider === "gmaps") {
      // Google Maps requires no login — public business listings only.
      const results = await scrapeGmaps(params as GmapsSearchParams);
      scraped = results.length;
      const counts = await importGmaps(job, results);
      imported = counts.imported;
      skipped = counts.skipped;
      resultPayload = { sample: results.slice(0, 3) };
    }

    await db
      .update(scrapingJobsTable)
      .set({
        status: "completed",
        finishedAt: new Date(),
        itemsScraped: scraped,
        itemsImported: imported,
        itemsSkipped: skipped,
        result: resultPayload,
      })
      .where(eq(scrapingJobsTable.id, jobId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // If the session is no longer valid (login wall, captcha, expired cookie),
    // flip the credential row to "expired" so the UI can prompt the user to
    // re-import cookies and so we don't keep retrying with dead credentials.
    const provider = job.provider as Provider;
    if (
      provider !== "gmaps" &&
      /session expired|invalid|login|checkpoint|captcha/i.test(msg)
    ) {
      await db
        .update(scrapingCredentialsTable)
        .set({
          status: "expired",
          lastError: msg,
          updatedAt: new Date(),
        })
        .where(eq(scrapingCredentialsTable.provider, provider));
    }
    await db
      .update(scrapingJobsTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: msg,
      })
      .where(eq(scrapingJobsTable.id, jobId));
    throw err;
  }
}

/**
 * Serialized worker queue. Only one scraping job runs at a time per process —
 * this matches the "un à la fois" requirement and avoids parallel browser
 * instances hammering the same provider session.
 */
let workerChain: Promise<void> = Promise.resolve();

export function runScrapingJob(jobId: number): Promise<void> {
  return executeJob(jobId);
}

export function enqueueJob(jobId: number): Promise<void> {
  const next = workerChain
    .catch(() => undefined)
    .then(() =>
      executeJob(jobId).catch((err) => {
        console.error(`[scraping] Job ${jobId} failed:`, err);
      }),
    );
  workerChain = next;
  return next;
}

/**
 * Fire-and-forget — schedules the job behind any in-flight job.
 */
export function runJobInBackground(jobId: number): void {
  void enqueueJob(jobId);
}
