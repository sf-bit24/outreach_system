import { eq, and, gte, lte, isNotNull, sql } from "drizzle-orm";
import {
  db,
  emailsTable,
  leadsTable,
  activitiesTable,
  senderSettingsTable,
  campaignsTable,
  type SenderSettings,
  type Email,
} from "@workspace/db";
import { sendEmail } from "./sender";
import { logger } from "../lib/logger";
import { randomBytes } from "node:crypto";

let queueRunning = false;
const queue: number[] = []; // email IDs

export async function getOrCreateSenderSettings(): Promise<SenderSettings> {
  const [existing] = await db.select().from(senderSettingsTable).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(senderSettingsTable)
    .values({})
    .returning();
  return created;
}

/** Compute the effective daily limit factoring in warmup ramp. */
export function computeWarmupLimit(settings: SenderSettings): number {
  if (!settings.warmupEnabled || !settings.warmupStartDate) {
    return settings.dailyLimit;
  }
  const startDate = new Date(settings.warmupStartDate);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  startDate.setUTCHours(0, 0, 0, 0);
  const daysPassed = Math.floor(
    (today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (daysPassed < 0) return settings.warmupStartVolume;
  const rampLimit =
    settings.warmupStartVolume + daysPassed * settings.warmupIncrement;
  return Math.min(rampLimit, settings.warmupMaxVolume);
}

async function emailsSentToday(): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable)
    .where(
      and(eq(emailsTable.status, "sent" as any), gte(emailsTable.sentAt, start)),
    );
  return row?.count ?? 0;
}

function ensureToken(existing: string | null): string {
  if (existing) return existing;
  return randomBytes(16).toString("hex");
}

/**
 * After a successful send, if the campaign has sequence steps, schedule
 * the next follow-up as a draft email with a future scheduledAt.
 */
async function scheduleNextSequenceStep(email: Email): Promise<void> {
  if (!email.campaignId) return;

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, email.campaignId));

  if (!campaign?.sequenceSteps || campaign.sequenceSteps.length === 0) return;

  // sequenceStepIndex=null or 0 means initial email
  const currentStep = email.sequenceStepIndex ?? 0;
  // sequenceSteps[0] = follow-up 1 (step index 1), sequenceSteps[1] = follow-up 2, etc.
  const nextStepArrayIdx = currentStep; // 0-based index into the array
  if (nextStepArrayIdx >= campaign.sequenceSteps.length) return; // no more steps

  const nextStep = campaign.sequenceSteps[nextStepArrayIdx];
  const scheduledAt = new Date(
    Date.now() + nextStep.delayDays * 24 * 60 * 60 * 1000,
  );
  // parentEmailId points to the root of the sequence chain
  const parentEmailId = email.parentEmailId ?? email.id;

  await db.insert(emailsTable).values({
    leadId: email.leadId,
    campaignId: email.campaignId,
    subject: nextStep.subject,
    body: nextStep.body,
    status: "draft",
    scheduledAt,
    sequenceStepIndex: currentStep + 1,
    parentEmailId,
  });

  logger.info(
    { leadId: email.leadId, campaignId: email.campaignId, step: currentStep + 1, scheduledAt },
    "Follow-up sequence step scheduled",
  );
}

/**
 * Cancel all pending draft follow-up emails for a lead/campaign.
 * Called when the lead replies or unsubscribes.
 */
export async function cancelPendingFollowUps(
  leadId: number,
  campaignId: number | null,
): Promise<number> {
  const conditions = [
    eq(emailsTable.leadId, leadId),
    eq(emailsTable.status, "draft" as any),
    isNotNull(emailsTable.sequenceStepIndex),
  ];
  if (campaignId != null) {
    conditions.push(eq(emailsTable.campaignId, campaignId));
  }

  const cancelled = await db
    .update(emailsTable)
    .set({ status: "failed", errorMessage: "Annulé — réponse reçue" })
    .where(and(...conditions))
    .returning({ id: emailsTable.id });

  if (cancelled.length > 0) {
    logger.info({ leadId, campaignId, count: cancelled.length }, "Pending follow-ups cancelled");
  }
  return cancelled.length;
}

/**
 * Find draft follow-up emails whose scheduledAt is now due and enqueue them.
 * Runs on a periodic timer.
 */
export async function processScheduledFollowUps(): Promise<void> {
  const now = new Date();
  const due = await db
    .select()
    .from(emailsTable)
    .where(
      and(
        eq(emailsTable.status, "draft" as any),
        isNotNull(emailsTable.sequenceStepIndex),
        lte(emailsTable.scheduledAt, now),
      ),
    );

  for (const email of due) {
    // Safety: check the lead hasn't replied or unsubscribed in the meantime
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, email.leadId));

    if (!lead || lead.unsubscribed) {
      await db
        .update(emailsTable)
        .set({ status: "failed", errorMessage: "Lead désinscrit — suivi annulé" })
        .where(eq(emailsTable.id, email.id));
      continue;
    }

    // Check if lead already replied in this campaign (any email in sequence)
    if (email.campaignId) {
      const [replied] = await db
        .select({ id: emailsTable.id })
        .from(emailsTable)
        .where(
          and(
            eq(emailsTable.leadId, email.leadId),
            eq(emailsTable.campaignId, email.campaignId),
            eq(emailsTable.status, "replied" as any),
          ),
        )
        .limit(1);

      if (replied) {
        await db
          .update(emailsTable)
          .set({ status: "failed", errorMessage: "Annulé — réponse reçue" })
          .where(eq(emailsTable.id, email.id));
        continue;
      }
    }

    enqueueEmail(email.id);
    logger.info({ emailId: email.id, step: email.sequenceStepIndex }, "Scheduled follow-up enqueued");
  }
}

/** Start the background scheduler that processes due follow-up emails. */
export function initScheduler(): void {
  // Run immediately then every 60 seconds
  processScheduledFollowUps().catch((err) =>
    logger.error({ err }, "processScheduledFollowUps error"),
  );
  setInterval(() => {
    processScheduledFollowUps().catch((err) =>
      logger.error({ err }, "processScheduledFollowUps error"),
    );
  }, 60_000);
  logger.info("Sequence follow-up scheduler started (60s interval)");
}

async function processOne(emailId: number): Promise<void> {
  const settings = await getOrCreateSenderSettings();

  const effectiveLimit = Math.min(
    settings.dailyLimit,
    computeWarmupLimit(settings),
  );

  const sentToday = await emailsSentToday();
  if (sentToday >= effectiveLimit) {
    logger.warn(
      { sentToday, effectiveLimit, dailyLimit: settings.dailyLimit },
      "Daily limit reached — pausing queue",
    );
    queue.unshift(emailId); // put back at front
    queueRunning = false;
    return;
  }

  const [email] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, emailId));
  if (!email) return;

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, email.leadId));
  if (!lead) return;

  if (lead.unsubscribed) {
    await db
      .update(emailsTable)
      .set({ status: "unsubscribed", errorMessage: "Lead unsubscribed" })
      .where(eq(emailsTable.id, email.id));
    return;
  }

  const token = ensureToken(lead.unsubscribeToken);
  if (!lead.unsubscribeToken) {
    await db
      .update(leadsTable)
      .set({ unsubscribeToken: token })
      .where(eq(leadsTable.id, lead.id));
  }

  const result = await sendEmail(email, lead, settings, token);

  if (result.success) {
    await db
      .update(emailsTable)
      .set({
        status: "sent",
        sentAt: new Date(),
        providerMessageId: result.providerMessageId ?? null,
      })
      .where(eq(emailsTable.id, email.id));

    await db
      .update(leadsTable)
      .set({ stage: "contacted", lastContactedAt: new Date() })
      .where(eq(leadsTable.id, lead.id));

    await db.insert(activitiesTable).values({
      type: "email_sent",
      description: result.simulated
        ? `Email simulé → ${lead.firstName} ${lead.lastName} — "${email.subject}"`
        : `Email envoyé → ${lead.firstName} ${lead.lastName} — "${email.subject}"`,
      leadName: `${lead.firstName} ${lead.lastName}`,
      leadId: lead.id,
      campaignId: email.campaignId ?? null,
    });

    // Schedule next sequence step if this campaign has follow-ups defined
    await scheduleNextSequenceStep(email).catch((err) =>
      logger.error({ err, emailId: email.id }, "scheduleNextSequenceStep error"),
    );
  } else {
    await db
      .update(emailsTable)
      .set({ status: "failed", errorMessage: result.error ?? "Unknown error" })
      .where(eq(emailsTable.id, email.id));
    logger.error({ emailId: email.id, error: result.error }, "Email send failed");
  }
}

function randomDelayMs(min: number, max: number): number {
  const m = Math.max(0, min) * 1000;
  const x = Math.max(m, max * 1000);
  return Math.floor(m + Math.random() * (x - m));
}

async function runLoop(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;

  try {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id == null) break;
      try {
        await processOne(id);
      } catch (err) {
        logger.error({ err, emailId: id }, "Queue processing error");
      }

      if (queue.length === 0) break;
      const settings = await getOrCreateSenderSettings();
      const delay = randomDelayMs(settings.delayMinSeconds, settings.delayMaxSeconds);
      logger.info({ delayMs: delay, remaining: queue.length }, "Sleeping before next email");
      await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    queueRunning = false;
  }
}

export function enqueueEmail(emailId: number): void {
  queue.push(emailId);
  db.update(emailsTable)
    .set({ status: "queued", scheduledAt: new Date() })
    .where(eq(emailsTable.id, emailId))
    .catch((err) => logger.error({ err, emailId }, "Failed to mark email queued"));
  runLoop().catch((err) => logger.error({ err }, "Queue runLoop crashed"));
}

export function queueStatus(): { running: boolean; pending: number } {
  return { running: queueRunning, pending: queue.length };
}
