import { Router, type IRouter } from "express";
import { eq, ilike, and, or, type SQL } from "drizzle-orm";
import { db, leadsTable, activitiesTable } from "@workspace/db";
import {
  ListLeadsQueryParams,
  CreateLeadBody,
  UpdateLeadBody,
  GetLeadParams,
  UpdateLeadParams,
  DeleteLeadParams,
  EnrichLeadParams,
  GetLeadResponse,
  ListLeadsResponse,
  EnrichLeadResponse,
  UpdateLeadResponse,
  ImportLeadsBody,
  ImportLeadsResponse,
} from "@workspace/api-zod";
import { enrichLead } from "../pipeline/enrich";
import { generateUnsubscribeToken } from "../pipeline/lcap";

const router: IRouter = Router();

router.get("/leads", async (req, res): Promise<void> => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stage, campaignId, search, source, emailStatus } = parsed.data as typeof parsed.data & { emailStatus?: string };
  const conditions: SQL[] = [];

  if (stage) conditions.push(eq(leadsTable.stage, stage as any));
  if (campaignId != null) conditions.push(eq(leadsTable.campaignId, campaignId));
  if (source) conditions.push(eq(leadsTable.source, source));
  if (emailStatus) conditions.push(eq(leadsTable.emailStatus, emailStatus));
  if (search) {
    const term = `%${search}%`;
    const cond = or(
      ilike(leadsTable.firstName, term),
      ilike(leadsTable.lastName, term),
      ilike(leadsTable.email, term),
      ilike(leadsTable.company, term),
    );
    if (cond) conditions.push(cond);
  }

  const leads =
    conditions.length > 0
      ? await db.select().from(leadsTable).where(and(...conditions))
      : await db.select().from(leadsTable);

  res.json(leads);
});

router.post("/leads/import", async (req, res): Promise<void> => {
  const parsed = ImportLeadsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { leads, campaignId } = parsed.data;
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const lead of leads) {
    try {
      const [inserted] = await db
        .insert(leadsTable)
        .values({
          ...lead,
          campaignId: lead.campaignId ?? campaignId ?? null,
          unsubscribeToken: generateUnsubscribeToken(),
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        imported++;
        await db.insert(activitiesTable).values({
          type: "lead_added",
          description: `Lead ${lead.firstName} ${lead.lastName} from ${lead.company} added`,
          leadName: `${lead.firstName} ${lead.lastName}`,
          leadId: inserted.id,
        });
      } else {
        skipped++;
      }
    } catch (e) {
      skipped++;
      errors.push(`Failed to import ${lead.email}: ${(e as Error).message}`);
    }
  }

  res.json({ imported, skipped, errors });
});

router.post("/leads", async (req, res): Promise<void> => {
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [lead] = await db
    .insert(leadsTable)
    .values({ ...parsed.data, unsubscribeToken: generateUnsubscribeToken() })
    .returning();

  await db.insert(activitiesTable).values({
    type: "lead_added",
    description: `Lead ${lead.firstName} ${lead.lastName} from ${lead.company} added`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
  });

  res.status(201).json(lead);
});

router.get("/leads/:id", async (req, res): Promise<void> => {
  const params = GetLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, params.data.id));

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.json(lead);
});

router.patch("/leads/:id", async (req, res): Promise<void> => {
  const params = UpdateLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stage, ...rest } = parsed.data;
  const [lead] = await db
    .update(leadsTable)
    .set({
      ...rest,
      ...(stage !== undefined ? { stage: stage as any } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leadsTable.id, params.data.id))
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.json(lead);
});

router.delete("/leads/:id", async (req, res): Promise<void> => {
  const params = DeleteLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lead] = await db
    .delete(leadsTable)
    .where(eq(leadsTable.id, params.data.id))
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.sendStatus(204);
});

/**
 * Stage 2 — Real enrichment pipeline (delegated to pipeline/enrich.ts):
 * 1. Scrape company website (cheerio) → summary + keywords + LCAP visibility
 * 2. Detect hiring signal from /careers, /jobs etc.
 * 3. Source a real email: crawl contact/legal pages for a published address and
 *    confirm it via SMTP (RCPT TO) before adopting it — never inventing one.
 * 4. Assess LCAP compliance, then promote to "verified" only on a deliverable
 *    SMTP result so the lead becomes eligible for sending.
 */
router.post("/leads/:id/enrich", async (req, res): Promise<void> => {
  const params = EnrichLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await enrichLead(params.data.id);
  if (!result) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.json(result.lead);
});

export default router;
