/**
 * Nightly auto-pipeline — trois crons UTC enregistrés via node-cron :
 *   02:00 → acquisition Google Maps (catégories × villes configurées)
 *   03:00 → enrichissement des leads en attente (concurrence max 3)
 *   03:30 → auto-assignation des leads vérifiés à la campagne par défaut
 *
 * Chaque cron vérifie `autoPipelineEnabled` à l'exécution (pas à l'init).
 * Les erreurs sont loguées et ne crashent jamais le serveur.
 */

import cron from "node-cron";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  senderSettingsTable,
  type SenderSettings,
} from "@workspace/db";
import { scrapingJobsTable } from "@workspace/db/schema";
import { getOrCreateSenderSettings } from "./queue";
import { enrichLead } from "./enrich";
import { runJobInBackground } from "../scraping/jobRunner";
import { logger } from "../lib/logger";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Generic last-run stamp (all 3 phases write here). */
async function persistSummary(
  settings: SenderSettings,
  summary: string,
): Promise<void> {
  await db
    .update(senderSettingsTable)
    .set({ lastAutoRunAt: new Date(), lastAutoRunSummary: summary })
    .where(eq(senderSettingsTable.id, settings.id));
}

/** Acquisition-specific stamp — never overwritten by enrichment or assign. */
async function persistAcquisitionSummary(
  settings: SenderSettings,
  summary: string,
): Promise<void> {
  await db
    .update(senderSettingsTable)
    .set({ lastAutoAcquisitionAt: new Date(), lastAutoAcquisitionSummary: summary })
    .where(eq(senderSettingsTable.id, settings.id));
}

/** Compute next 02:00 UTC as an ISO string for the status endpoint. */
export function nextRunAt(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0, 0),
  );
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

// ── acquisition ───────────────────────────────────────────────────────────────

export async function runNightlyAcquisition(): Promise<{
  jobsCreated: number;
  summary: string;
}> {
  const settings = await getOrCreateSenderSettings();
  if (!settings.autoPipelineEnabled) {
    return { jobsCreated: 0, summary: "Pipeline désactivé" };
  }

  const categories = settings.autoAcquireCategories as string[];
  const cities = settings.autoAcquireCities as string[];

  if (categories.length === 0 || cities.length === 0) {
    const msg = "Aucune catégorie ou ville configurée";
    await persistSummary(settings, msg);
    await persistAcquisitionSummary(settings, msg);
    return { jobsCreated: 0, summary: msg };
  }

  // Count gmaps_scrape leads created in the last 24 h (result of previous run)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(and(eq(leadsTable.source, "gmaps_scrape"), sql`${leadsTable.createdAt} >= ${dayAgo}`));
  const leadsImported = countRow?.count ?? 0;

  const pairs = categories.length * cities.length;
  const maxPerJob = Math.max(1, Math.ceil(settings.autoAcquireMaxPerRun / pairs));
  let jobsCreated = 0;

  for (const category of categories) {
    for (const city of cities) {
      try {
        const [job] = await db
          .insert(scrapingJobsTable)
          .values({
            provider: "gmaps",
            params: { category, city, maxResults: maxPerJob },
            status: "queued",
          })
          .returning();
        if (job) {
          runJobInBackground(job.id);
          jobsCreated++;
          logger.info({ jobId: job.id, category, city }, "Auto-pipeline: gmaps job queued");
        }
      } catch (err) {
        logger.error({ err, category, city }, "Auto-pipeline: failed to create gmaps job");
      }
    }
  }

  const acquisitionSummary =
    `${jobsCreated} jobs lancés · ${leadsImported} leads importés les 24h précédentes` +
    ` (${categories.length} catég. × ${cities.length} villes, max ${maxPerJob}/job)`;
  await persistSummary(settings, `Acquisition : ${acquisitionSummary}`);
  await persistAcquisitionSummary(settings, acquisitionSummary);
  return { jobsCreated, summary: acquisitionSummary };
}

// ── enrichment ────────────────────────────────────────────────────────────────

export async function runNightlyEnrichment(): Promise<{
  enriched: number;
  failed: number;
  summary: string;
}> {
  const settings = await getOrCreateSenderSettings();
  if (!settings.autoPipelineEnabled) {
    return { enriched: 0, failed: 0, summary: "Pipeline désactivé" };
  }

  // Only enrich leads created > 30 min ago to give scraping jobs time to finish
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

  const pending = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.emailStatus, "needs_enrichment"),
        sql`${leadsTable.createdAt} < ${thirtyMinAgo}`,
      ),
    )
    .limit(200);

  if (pending.length === 0) {
    const msg = "Enrichissement : aucun lead en attente";
    await persistSummary(settings, msg);
    return { enriched: 0, failed: 0, summary: msg };
  }

  let enriched = 0;
  let failed = 0;

  // Concurrency = 3 (caps outbound SMTP/DNS probes)
  const CONCURRENCY = 3;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((l) => enrichLead(l.id)));
    for (const r of results) {
      if (r.status === "fulfilled") enriched++;
      else {
        failed++;
        logger.warn({ reason: (r as PromiseRejectedResult).reason }, "Auto-pipeline: enrichment failed for one lead");
      }
    }
  }

  const summary = `Enrichissement : ${enriched} leads traités, ${failed} échecs`;
  await persistSummary(settings, summary);
  return { enriched, failed, summary };
}

// ── auto-assign ───────────────────────────────────────────────────────────────

export async function runNightlyAssign(): Promise<{
  assigned: number;
  summary: string;
}> {
  const settings = await getOrCreateSenderSettings();
  if (!settings.autoPipelineEnabled) {
    return { assigned: 0, summary: "Pipeline désactivé" };
  }
  if (!settings.autoAssignCampaignId) {
    const msg = "Auto-assign : aucune campagne configurée";
    await persistSummary(settings, msg);
    return { assigned: 0, summary: msg };
  }

  const eligible = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.emailStatus, "verified"),
        eq(leadsTable.lcapCompliant, true),
        isNull(leadsTable.campaignId),
      ),
    )
    .limit(500);

  if (eligible.length === 0) {
    const msg = "Auto-assign : aucun lead éligible";
    await persistSummary(settings, msg);
    return { assigned: 0, summary: msg };
  }

  const ids = eligible.map((l) => l.id);

  await db
    .update(leadsTable)
    .set({ campaignId: settings.autoAssignCampaignId })
    .where(inArray(leadsTable.id, ids));

  const summary = `Auto-assign : ${ids.length} leads assignés à la campagne #${settings.autoAssignCampaignId}`;
  await persistSummary(settings, summary);
  logger.info({ count: ids.length, campaignId: settings.autoAssignCampaignId }, "Auto-pipeline: leads assigned");
  return { assigned: ids.length, summary };
}

// ── cron init ─────────────────────────────────────────────────────────────────

export function initAutoPipeline(): void {
  // 02:00 UTC — Google Maps acquisition
  cron.schedule("0 2 * * *", async () => {
    logger.info("Auto-pipeline: nightly acquisition starting");
    try {
      const r = await runNightlyAcquisition();
      logger.info(r, "Auto-pipeline: acquisition done");
    } catch (err) {
      logger.error({ err }, "Auto-pipeline: acquisition cron crashed");
    }
  }, { timezone: "UTC" });

  // 03:00 UTC — enrichment
  cron.schedule("0 3 * * *", async () => {
    logger.info("Auto-pipeline: nightly enrichment starting");
    try {
      const r = await runNightlyEnrichment();
      logger.info(r, "Auto-pipeline: enrichment done");
    } catch (err) {
      logger.error({ err }, "Auto-pipeline: enrichment cron crashed");
    }
  }, { timezone: "UTC" });

  // 03:30 UTC — auto-assign to campaign
  cron.schedule("30 3 * * *", async () => {
    logger.info("Auto-pipeline: nightly auto-assign starting");
    try {
      const r = await runNightlyAssign();
      logger.info(r, "Auto-pipeline: auto-assign done");
    } catch (err) {
      logger.error({ err }, "Auto-pipeline: auto-assign cron crashed");
    }
  }, { timezone: "UTC" });

  logger.info("Auto-pipeline crons registered (02:00 acquire, 03:00 enrich, 03:30 assign — UTC)");
}
