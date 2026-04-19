import { Router, type IRouter } from "express";
import { eq, and, type SQL } from "drizzle-orm";
import { db, emailsTable, leadsTable, activitiesTable } from "@workspace/db";
import {
  ListEmailsQueryParams,
  ListEmailsResponse,
  GenerateEmailBody,
  GetEmailParams,
  UpdateEmailParams,
  SendEmailParams,
  GetEmailResponse,
  UpdateEmailBody,
  UpdateEmailResponse,
  SendEmailResponse,
} from "@workspace/api-zod";
import { personalizeEmail } from "../pipeline/aiPersonalization";
import { enqueueEmail, getOrCreateSenderSettings } from "../pipeline/queue";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/emails", async (req, res): Promise<void> => {
  const parsed = ListEmailsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { leadId, campaignId, status } = parsed.data;
  const conditions: SQL[] = [];

  if (leadId != null) conditions.push(eq(emailsTable.leadId, leadId));
  if (campaignId != null) conditions.push(eq(emailsTable.campaignId, campaignId));
  if (status) conditions.push(eq(emailsTable.status, status as any));

  const emails =
    conditions.length > 0
      ? await db.select().from(emailsTable).where(and(...conditions))
      : await db.select().from(emailsTable);

  res.json(emails);
});

router.post("/emails/generate", async (req, res): Promise<void> => {
  const parsed = GenerateEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, parsed.data.leadId));

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  if (lead.unsubscribed) {
    res.status(400).json({ error: "Lead has unsubscribed — cannot generate email" });
    return;
  }

  if (lead.lcapCompliant === false) {
    res.status(400).json({
      error: `LCAP non conforme: ${lead.lcapReason ?? "voir le profil du lead"}`,
    });
    return;
  }

  const settings = await getOrCreateSenderSettings();

  let subject: string;
  let body: string;
  let hook: string;
  try {
    const personalized = await personalizeEmail(lead, settings);
    subject = personalized.subject;
    body = personalized.body;
    hook = personalized.hook;
  } catch (err) {
    logger.error({ err, leadId: lead.id }, "AI personalization failed");
    res.status(502).json({
      error: `AI personalization failed: ${(err as Error).message}`,
    });
    return;
  }

  const [email] = await db
    .insert(emailsTable)
    .values({
      leadId: lead.id,
      campaignId: parsed.data.campaignId ?? lead.campaignId ?? null,
      subject,
      body,
      hook,
      status: "draft",
    })
    .returning();

  await db
    .update(leadsTable)
    .set({ stage: "email_generated", updatedAt: new Date() })
    .where(eq(leadsTable.id, lead.id));

  await db.insert(activitiesTable).values({
    type: "email_generated",
    description: `AI email generated for ${lead.firstName} ${lead.lastName} — "${subject}"`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
    campaignId: email.campaignId ?? null,
  });

  res.status(201).json(email);
});

router.get("/emails/:id", async (req, res): Promise<void> => {
  const params = GetEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [email] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, params.data.id));

  if (!email) {
    res.status(404).json({ error: "Email not found" });
    return;
  }

  res.json(email);
});

router.patch("/emails/:id", async (req, res): Promise<void> => {
  const params = UpdateEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [email] = await db
    .update(emailsTable)
    .set(parsed.data)
    .where(eq(emailsTable.id, params.data.id))
    .returning();

  if (!email) {
    res.status(404).json({ error: "Email not found" });
    return;
  }

  res.json(email);
});

router.post("/emails/:id/send", async (req, res): Promise<void> => {
  const params = SendEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [email] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, params.data.id));

  if (!email) {
    res.status(404).json({ error: "Email not found" });
    return;
  }

  if (email.status === "sent") {
    res.status(400).json({ error: "Email already sent" });
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, email.leadId));

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  if (lead.unsubscribed) {
    res.status(400).json({ error: "Lead unsubscribed — send blocked" });
    return;
  }

  // Enqueue rather than send synchronously: respects daily limit + delay
  enqueueEmail(email.id);

  const [updated] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, email.id));

  res.json(updated);
});

export default router;
