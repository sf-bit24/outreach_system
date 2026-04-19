import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, leadsTable, campaignsTable, emailsTable, activitiesTable } from "@workspace/db";
import {
  GetDashboardStatsResponse,
  GetPipelineResponse,
  GetActivityResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/stats", async (_req, res): Promise<void> => {
  const [totals] = await db
    .select({
      totalLeads: sql<number>`count(*)::int`,
    })
    .from(leadsTable);

  const [enriched] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(sql`stage != 'raw'`);

  const [emailsGenerated] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable);

  const [emailsSent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable)
    .where(sql`status IN ('sent','opened','replied')`);

  const [emailsOpened] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable)
    .where(sql`status IN ('opened','replied')`);

  const [emailsReplied] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailsTable)
    .where(eq(emailsTable.status, "replied"));

  const [activeCampaigns] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignsTable)
    .where(eq(campaignsTable.status, "active"));

  const totalSent = emailsSent?.count ?? 0;
  const totalReplied = emailsReplied?.count ?? 0;
  const totalOpened = emailsOpened?.count ?? 0;

  const stats = {
    totalLeads: totals?.totalLeads ?? 0,
    enrichedLeads: enriched?.count ?? 0,
    emailsGenerated: emailsGenerated?.count ?? 0,
    emailsSent: totalSent,
    emailsOpened: totalOpened,
    emailsReplied: totalReplied,
    activeCampaigns: activeCampaigns?.count ?? 0,
    replyRate: totalSent > 0 ? Math.round((totalReplied / totalSent) * 1000) / 10 : 0,
    openRate: totalSent > 0 ? Math.round((totalOpened / totalSent) * 1000) / 10 : 0,
  };

  res.json(GetDashboardStatsResponse.parse(stats));
});

router.get("/dashboard/pipeline", async (_req, res): Promise<void> => {
  const stageLabels: Record<string, string> = {
    raw: "Raw",
    enriched: "Enriched",
    email_generated: "Email Generated",
    contacted: "Contacted",
    replied: "Replied",
    converted: "Converted",
    unsubscribed: "Unsubscribed",
  };

  const stages = await db
    .select({
      stage: leadsTable.stage,
      count: sql<number>`count(*)::int`,
    })
    .from(leadsTable)
    .groupBy(leadsTable.stage);

  const pipeline = stages.map((s) => ({
    stage: s.stage,
    count: s.count,
    label: stageLabels[s.stage] ?? s.stage,
  }));

  res.json(GetPipelineResponse.parse(pipeline));
});

router.get("/dashboard/activity", async (_req, res): Promise<void> => {
  const activities = await db
    .select()
    .from(activitiesTable)
    .orderBy(sql`created_at DESC`)
    .limit(20);

  res.json(GetActivityResponse.parse(activities));
});

export default router;
