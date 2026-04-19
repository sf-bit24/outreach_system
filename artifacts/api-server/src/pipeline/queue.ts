import { eq, and, gte, sql } from "drizzle-orm";
import {
  db,
  emailsTable,
  leadsTable,
  activitiesTable,
  senderSettingsTable,
  type SenderSettings,
} from "@workspace/db";
import { sendEmailViaResend } from "./sender";
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

async function processOne(emailId: number): Promise<void> {
  const settings = await getOrCreateSenderSettings();

  const sentToday = await emailsSentToday();
  if (sentToday >= settings.dailyLimit) {
    logger.warn({ sentToday, dailyLimit: settings.dailyLimit }, "Daily limit reached — pausing queue");
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

  const result = await sendEmailViaResend(email, lead, settings, token);

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
        ? `Email queued (simulation) → ${lead.firstName} ${lead.lastName} — "${email.subject}"`
        : `Email sent → ${lead.firstName} ${lead.lastName} — "${email.subject}"`,
      leadName: `${lead.firstName} ${lead.lastName}`,
      leadId: lead.id,
      campaignId: email.campaignId ?? null,
    });
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
