/**
 * triggerAutoPipeline — standalone module so enrich.ts can import it
 * without creating a circular dependency with autoPipeline.ts.
 *
 * autoPipeline.ts  →  enrich.ts  (nightly enrichment)
 * enrich.ts        →  autoPipelineTrigger.ts  (post-enrichment hook)
 * No cycle.
 */

import { eq, and, ne } from "drizzle-orm";
import {
  db,
  leadsTable,
  senderSettingsTable,
  emailsTable,
  activitiesTable,
  type Lead,
} from "@workspace/db";
import { getOrCreateSenderSettings, enqueueEmail } from "./queue";
import { personalizeEmail } from "./aiPersonalization";
import { logger } from "../lib/logger";

/**
 * Called non-blockingly after `enrichLead()` (and from the manual API endpoint)
 * once a lead reaches `emailStatus='verified'` + `lcapCompliant=true`.
 *
 * Guards:
 *   - autoPipelineEnabled must be true
 *   - autoAssignCampaignId must be set
 *   - No non-failed email must already exist for this lead + campaign
 *
 * Flow: assign → AI personalize → insert draft email → enqueue → log activity.
 */
export async function triggerAutoPipeline(
  lead: Lead,
): Promise<{ emailId: number; message: string } | null> {
  const settings = await getOrCreateSenderSettings();

  if (!settings.autoPipelineEnabled || !settings.autoAssignCampaignId) {
    return null;
  }

  if (lead.emailStatus !== "verified" || !lead.lcapCompliant) {
    return null;
  }

  const [existingEmail] = await db
    .select({ id: emailsTable.id })
    .from(emailsTable)
    .where(
      and(
        eq(emailsTable.leadId, lead.id),
        eq(emailsTable.campaignId, settings.autoAssignCampaignId),
        ne(emailsTable.status, "failed" as any),
      ),
    )
    .limit(1);

  if (existingEmail) {
    logger.info(
      { leadId: lead.id, campaignId: settings.autoAssignCampaignId, emailId: existingEmail.id },
      "Auto-pipeline: email already exists — skipping",
    );
    return null;
  }

  let activeLead = lead;
  if (lead.campaignId !== settings.autoAssignCampaignId) {
    const [updated] = await db
      .update(leadsTable)
      .set({ campaignId: settings.autoAssignCampaignId })
      .where(eq(leadsTable.id, lead.id))
      .returning();
    if (updated) activeLead = updated;
  }

  const personalized = await personalizeEmail(activeLead, settings);

  const [email] = await db
    .insert(emailsTable)
    .values({
      leadId: activeLead.id,
      campaignId: settings.autoAssignCampaignId,
      subject: personalized.subject,
      body: personalized.body,
      hook: personalized.hook,
      status: "draft",
    })
    .returning();

  if (!email) throw new Error("Auto-pipeline: failed to insert email");

  await db.insert(activitiesTable).values({
    type: "email_generated",
    description: `Auto-pipeline : email généré et mis en queue pour ${activeLead.firstName} ${activeLead.lastName}`,
    leadName: `${activeLead.firstName} ${activeLead.lastName}`,
    leadId: activeLead.id,
    campaignId: settings.autoAssignCampaignId,
  });

  enqueueEmail(email.id);

  logger.info(
    { leadId: activeLead.id, emailId: email.id, campaignId: settings.autoAssignCampaignId },
    "Auto-pipeline: email generated and enqueued",
  );

  return {
    emailId: email.id,
    message: `Email généré et mis en queue pour ${activeLead.firstName} ${activeLead.lastName} (campagne #${settings.autoAssignCampaignId})`,
  };
}
