import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, campaignsTable, leadsTable, emailsTable, activitiesTable } from "@workspace/db";
import {
  ListCampaignsResponse,
  GetCampaignResponse,
  CreateCampaignBody,
  UpdateCampaignBody,
  GetCampaignParams,
  UpdateCampaignParams,
  DeleteCampaignParams,
  StartCampaignParams,
  PauseCampaignParams,
  StartCampaignResponse,
  PauseCampaignResponse,
  UpdateCampaignResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function campaignWithStats(id: number) {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id));
  if (!campaign) return null;

  const [leadCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(eq(leadsTable.campaignId, id));

  const [contactedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable)
    .where(eq(emailsTable.campaignId, id));

  const [repliedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable)
    .where(eq(emailsTable.campaignId, id));

  return {
    ...campaign,
    totalLeads: leadCount?.count ?? 0,
    contacted: contactedCount?.count ?? 0,
    replied: repliedCount?.count ?? 0,
  };
}

router.get("/campaigns", async (_req, res): Promise<void> => {
  const campaigns = await db.select().from(campaignsTable);

  const enriched = await Promise.all(
    campaigns.map(async (c) => {
      const [leadCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(leadsTable)
        .where(eq(leadsTable.campaignId, c.id));

      const [sentCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(emailsTable)
        .where(eq(emailsTable.campaignId, c.id));

      const [repliedCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(emailsTable)
        .where(eq(emailsTable.campaignId, c.id));

      return {
        ...c,
        totalLeads: leadCount?.count ?? 0,
        contacted: sentCount?.count ?? 0,
        replied: repliedCount?.count ?? 0,
      };
    })
  );

  res.json(ListCampaignsResponse.parse(enriched));
});

router.post("/campaigns", async (req, res): Promise<void> => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [campaign] = await db
    .insert(campaignsTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(
    GetCampaignResponse.parse({
      ...campaign,
      totalLeads: 0,
      contacted: 0,
      replied: 0,
    })
  );
});

router.get("/campaigns/:id", async (req, res): Promise<void> => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const campaign = await campaignWithStats(params.data.id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  res.json(GetCampaignResponse.parse(campaign));
});

router.patch("/campaigns/:id", async (req, res): Promise<void> => {
  const params = UpdateCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ ...parsed.data, updatedAt: new Date() } as any)
    .where(eq(campaignsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const campaign = await campaignWithStats(updated.id);
  res.json(UpdateCampaignResponse.parse(campaign));
});

router.delete("/campaigns/:id", async (req, res): Promise<void> => {
  const params = DeleteCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [campaign] = await db
    .delete(campaignsTable)
    .where(eq(campaignsTable.id, params.data.id))
    .returning();

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/campaigns/:id/start", async (req, res): Promise<void> => {
  const params = StartCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [campaign] = await db
    .update(campaignsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(campaignsTable.id, params.data.id))
    .returning();

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  await db.insert(activitiesTable).values({
    type: "campaign_started",
    description: `Campaign "${campaign.name}" started`,
    campaignName: campaign.name,
    campaignId: campaign.id,
  });

  const full = await campaignWithStats(campaign.id);
  res.json(StartCampaignResponse.parse(full));
});

router.post("/campaigns/:id/pause", async (req, res): Promise<void> => {
  const params = PauseCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [campaign] = await db
    .update(campaignsTable)
    .set({ status: "paused", updatedAt: new Date() })
    .where(eq(campaignsTable.id, params.data.id))
    .returning();

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  await db.insert(activitiesTable).values({
    type: "campaign_paused",
    description: `Campaign "${campaign.name}" paused`,
    campaignName: campaign.name,
    campaignId: campaign.id,
  });

  const full = await campaignWithStats(campaign.id);
  res.json(PauseCampaignResponse.parse(full));
});

export default router;
