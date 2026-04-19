import { Router, type IRouter } from "express";
import { eq, ilike, and, type SQL } from "drizzle-orm";
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

const router: IRouter = Router();

router.get("/leads", async (req, res): Promise<void> => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stage, campaignId, search } = parsed.data;
  const conditions: SQL[] = [];

  if (stage) {
    conditions.push(eq(leadsTable.stage, stage as any));
  }
  if (campaignId != null) {
    conditions.push(eq(leadsTable.campaignId, campaignId));
  }
  if (search) {
    conditions.push(
      ilike(leadsTable.firstName, `%${search}%`)
    );
  }

  const leads =
    conditions.length > 0
      ? await db.select().from(leadsTable).where(and(...conditions))
      : await db.select().from(leadsTable);

  res.json(ListLeadsResponse.parse(leads));
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
      await db
        .insert(leadsTable)
        .values({
          ...lead,
          campaignId: lead.campaignId ?? campaignId ?? null,
        })
        .onConflictDoNothing();
      imported++;

      await db.insert(activitiesTable).values({
        type: "lead_added",
        description: `Lead ${lead.firstName} ${lead.lastName} from ${lead.company} added`,
        leadName: `${lead.firstName} ${lead.lastName}`,
      });
    } catch (e) {
      skipped++;
      errors.push(`Failed to import ${lead.email}: ${(e as Error).message}`);
    }
  }

  res.json(ImportLeadsResponse.parse({ imported, skipped, errors }));
});

router.post("/leads", async (req, res): Promise<void> => {
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [lead] = await db.insert(leadsTable).values(parsed.data).returning();

  await db.insert(activitiesTable).values({
    type: "lead_added",
    description: `Lead ${lead.firstName} ${lead.lastName} from ${lead.company} added`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
  });

  res.status(201).json(GetLeadResponse.parse(lead));
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

  res.json(GetLeadResponse.parse(lead));
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

  const [lead] = await db
    .update(leadsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(leadsTable.id, params.data.id))
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.json(UpdateLeadResponse.parse(lead));
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

router.post("/leads/:id/enrich", async (req, res): Promise<void> => {
  const params = EnrichLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  // Simulate enrichment
  const enrichmentData = {
    emailValid: true,
    isHiring: Math.random() > 0.5,
    intentSignal:
      Math.random() > 0.5 ? "Currently hiring VP Sales" : "Raised Series A 3 months ago",
    stage: "enriched" as const,
    updatedAt: new Date(),
  };

  const [lead] = await db
    .update(leadsTable)
    .set(enrichmentData)
    .where(eq(leadsTable.id, params.data.id))
    .returning();

  await db.insert(activitiesTable).values({
    type: "lead_enriched",
    description: `Lead ${lead.firstName} ${lead.lastName} enriched with intent signals`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
  });

  res.json(EnrichLeadResponse.parse(lead));
});

export default router;
