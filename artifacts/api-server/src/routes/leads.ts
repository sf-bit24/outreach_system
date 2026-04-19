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
import { validateEmail } from "../pipeline/emailValidator";
import { analyzeWebsite, detectHiringSignal } from "../pipeline/websiteScraper";
import { assessLcap, generateUnsubscribeToken } from "../pipeline/lcap";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/leads", async (req, res): Promise<void> => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stage, campaignId, search } = parsed.data;
  const conditions: SQL[] = [];

  if (stage) conditions.push(eq(leadsTable.stage, stage as any));
  if (campaignId != null) conditions.push(eq(leadsTable.campaignId, campaignId));
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
 * Stage 2 — Real enrichment pipeline:
 * 1. Scrape company website (cheerio) → extract summary + keywords + visible emails
 * 2. Detect hiring signal from /careers, /jobs etc.
 * 3. Validate email syntax + DNS MX record
 * 4. Assess LCAP compliance based on web visibility + opt-out mentions + role
 */
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

  logger.info({ leadId: existing.id }, "Starting enrichment pipeline");

  // Run each step independently — partial enrichment is better than nothing
  const [websiteRes, hiringRes, emailRes] = await Promise.allSettled([
    analyzeWebsite(existing.website, existing.email),
    detectHiringSignal(existing.website),
    validateEmail(existing.email),
  ]);

  const website =
    websiteRes.status === "fulfilled"
      ? websiteRes.value
      : {
          reachable: false,
          summary: "",
          keywords: [],
          emailsFound: [],
          emailVisibleOnSite: false,
          noOptOutMention: true,
          fetchedUrl: null,
        };
  const hiring =
    hiringRes.status === "fulfilled"
      ? hiringRes.value
      : { isHiring: false, intentSignal: null };
  const emailCheck =
    emailRes.status === "fulfilled"
      ? emailRes.value
      : { valid: false, reason: "Validation failed (transient error)", hasMxRecord: false };

  if (websiteRes.status === "rejected") {
    logger.warn({ err: websiteRes.reason, leadId: existing.id }, "Website analysis failed");
  }
  if (hiringRes.status === "rejected") {
    logger.warn({ err: hiringRes.reason, leadId: existing.id }, "Hiring detection failed");
  }
  if (emailRes.status === "rejected") {
    logger.warn({ err: emailRes.reason, leadId: existing.id }, "Email validation failed");
  }

  const lcap = assessLcap({
    emailVisibleOnSite: website.emailVisibleOnSite,
    noOptOutMention: website.noOptOutMention,
    hasJobTitle: Boolean(existing.jobTitle && existing.jobTitle.trim()),
    emailValid: emailCheck.valid,
  });

  const intentSignal =
    hiring.intentSignal ??
    (website.keywords.length > 0
      ? `Mots-clés du site: ${website.keywords.slice(0, 5).join(", ")}`
      : null);

  const [lead] = await db
    .update(leadsTable)
    .set({
      emailValid: emailCheck.valid,
      emailValidationReason: emailCheck.reason,
      isHiring: hiring.isHiring,
      intentSignal,
      websiteSummary: website.summary || null,
      websiteKeywords: website.keywords.length > 0 ? website.keywords.join(", ") : null,
      lcapCompliant: lcap.compliant,
      lcapReason: lcap.reason,
      stage: "enriched",
      unsubscribeToken: existing.unsubscribeToken ?? generateUnsubscribeToken(),
      updatedAt: new Date(),
    })
    .where(eq(leadsTable.id, params.data.id))
    .returning();

  await db.insert(activitiesTable).values({
    type: "lead_enriched",
    description: `Enriched ${lead.firstName} ${lead.lastName} — ${lcap.compliant ? "LCAP OK" : "LCAP non conforme"}${hiring.isHiring ? " · hiring signal" : ""}`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
  });

  res.json(lead);
});

export default router;
