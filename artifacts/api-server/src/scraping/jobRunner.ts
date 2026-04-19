import { db } from "@workspace/db";
import {
  scrapingJobsTable,
  scrapingCredentialsTable,
  leadsTable,
  type ScrapingJob,
} from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { decryptJson } from "./crypto";
import { scrapeApollo, type ScrapedApolloPerson } from "./apolloScraper";
import { scrapeLinkedIn, type ScrapedLinkedInPerson } from "./linkedinScraper";
import type { StoredCredentials } from "./browser";

type Provider = "apollo" | "linkedin";

const RATE_LIMITS: Record<Provider, { perHour: number }> = {
  apollo: { perHour: 200 },
  linkedin: { perHour: 100 },
};

async function loadCredentials(
  provider: Provider,
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

async function importApollo(
  job: ScrapingJob,
  results: ScrapedApolloPerson[],
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of results) {
    const key = dedupeKey(r);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    // Skip locked emails — never insert with fake/locked email
    if (!r.email && !r.linkedinUrl) {
      skipped++;
      continue;
    }
    // If email exists, dedupe on it
    if (r.email) {
      const existing = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(eq(leadsTable.email, r.email.toLowerCase()))
        .limit(1);
      if (existing.length) {
        skipped++;
        continue;
      }
    }
    try {
      await db.insert(leadsTable).values({
        firstName: r.firstName || "Unknown",
        lastName: r.lastName || "",
        // Apollo locked rows have no real email — store a placeholder we can never send to
        email: r.email?.toLowerCase() ?? `locked+apollo-${Date.now()}-${imported}@example.invalid`,
        company: r.company ?? "Unknown",
        jobTitle: r.jobTitle ?? "Unknown",
        linkedinUrl: r.linkedinUrl,
        location: r.location,
        source: "apollo_scrape",
        sourceUrl: r.sourceUrl,
        // Even visible Apollo emails are NEVER trusted for direct sending.
        // Mark as "scraped" so the sender guard blocks them until enrichment verifies.
        emailStatus: r.email ? "scraped" : "locked",
        emailLocked: true,
        scrapedAt: new Date(),
      });
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

async function importLinkedIn(
  job: ScrapingJob,
  results: ScrapedLinkedInPerson[],
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
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
    const existing = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.linkedinUrl, r.linkedinUrl))
      .limit(1);
    if (existing.length) {
      skipped++;
      continue;
    }
    try {
      // LinkedIn never gives emails in search; mark as needs_enrichment
      // Use placeholder email that will be filtered out of sending queue
      const placeholder = `pending+li-${Date.now()}-${imported}@example.invalid`;
      await db.insert(leadsTable).values({
        firstName: r.firstName || "Unknown",
        lastName: r.lastName || "",
        email: placeholder,
        company: r.company ?? "Unknown",
        jobTitle: r.jobTitle ?? "Unknown",
        linkedinUrl: r.linkedinUrl,
        location: r.location,
        source: "linkedin_scrape",
        sourceUrl: r.sourceUrl,
        emailStatus: "needs_enrichment",
        emailLocked: true,
        scrapedAt: new Date(),
      });
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

export async function runScrapingJob(jobId: number): Promise<void> {
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
    await checkRateLimit(job.provider as Provider);
    const creds = await loadCredentials(job.provider as Provider);
    const params = job.params as Record<string, unknown>;

    let scraped = 0;
    let imported = 0;
    let skipped = 0;
    let resultPayload: unknown = null;

    if (job.provider === "apollo") {
      const results = await scrapeApollo(creds, params as never);
      scraped = results.length;
      const counts = await importApollo(job, results);
      imported = counts.imported;
      skipped = counts.skipped;
      resultPayload = { sample: results.slice(0, 3) };
    } else if (job.provider === "linkedin") {
      const results = await scrapeLinkedIn(creds, params as never);
      scraped = results.length;
      const counts = await importLinkedIn(job, results);
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
        result: resultPayload as never,
      })
      .where(eq(scrapingJobsTable.id, jobId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
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
 * Fire-and-forget — runs the job in the background. Errors are persisted on the job row.
 */
export function runJobInBackground(jobId: number): void {
  void runScrapingJob(jobId).catch((err) => {
    console.error(`[scraping] Job ${jobId} failed:`, err);
  });
}
