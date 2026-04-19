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

const router: IRouter = Router();

router.get("/emails", async (req, res): Promise<void> => {
  const parsed = ListEmailsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { leadId, campaignId, status } = parsed.data;
  const conditions: SQL[] = [];

  if (leadId != null) {
    conditions.push(eq(emailsTable.leadId, leadId));
  }
  if (campaignId != null) {
    conditions.push(eq(emailsTable.campaignId, campaignId));
  }
  if (status) {
    conditions.push(eq(emailsTable.status, status as any));
  }

  const emails =
    conditions.length > 0
      ? await db.select().from(emailsTable).where(and(...conditions))
      : await db.select().from(emailsTable);

  res.json(ListEmailsResponse.parse(emails));
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

  const intentHook = lead.intentSignal
    ? `J'ai remarqué que ${lead.company} ${lead.intentSignal.toLowerCase()}, ce qui m'a donné l'idée de vous contacter.`
    : lead.isHiring
    ? `J'ai vu que vous recrutez activement chez ${lead.company} — souvent signe d'une phase de croissance qui amène de nouveaux défis.`
    : `En parcourant le site de ${lead.company}, j'ai été impressionné par votre positionnement sur le marché.`;

  const subject = `Question rapide pour ${lead.firstName} — ${lead.company}`;
  const hook = intentHook;
  const body = `Bonjour ${lead.firstName},

${hook}

Je travaille avec des entreprises comme la vôtre pour [valeur proposée]. En 3 mois, nos clients voient en moyenne [résultat chiffré].

Seriez-vous disponible pour un échange de 15 minutes la semaine prochaine ?

Cordialement,
[Votre nom]`;

  const [email] = await db
    .insert(emailsTable)
    .values({
      leadId: lead.id,
      campaignId: parsed.data.campaignId ?? null,
      subject,
      body,
      hook,
      status: "draft",
    })
    .returning();

  // Update lead stage
  await db
    .update(leadsTable)
    .set({ stage: "email_generated", updatedAt: new Date() })
    .where(eq(leadsTable.id, lead.id));

  await db.insert(activitiesTable).values({
    type: "email_generated",
    description: `Email generated for ${lead.firstName} ${lead.lastName} at ${lead.company}`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
    campaignId: parsed.data.campaignId ?? null,
  });

  res.status(201).json(GetEmailResponse.parse(email));
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

  res.json(GetEmailResponse.parse(email));
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

  res.json(UpdateEmailResponse.parse(email));
});

router.post("/emails/:id/send", async (req, res): Promise<void> => {
  const params = SendEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [email] = await db
    .update(emailsTable)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(emailsTable.id, params.data.id))
    .returning();

  if (!email) {
    res.status(404).json({ error: "Email not found" });
    return;
  }

  // Update lead stage to contacted
  await db
    .update(leadsTable)
    .set({ stage: "contacted", updatedAt: new Date() })
    .where(eq(leadsTable.id, email.leadId));

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, email.leadId));

  await db.insert(activitiesTable).values({
    type: "email_sent",
    description: `Email sent to ${lead?.firstName ?? ""} ${lead?.lastName ?? ""} — "${email.subject}"`,
    leadName: lead ? `${lead.firstName} ${lead.lastName}` : null,
    leadId: email.leadId,
    campaignId: email.campaignId ?? null,
  });

  res.json(SendEmailResponse.parse(email));
});

export default router;
