import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, emailsTable, leadsTable, activitiesTable } from "@workspace/db";
import { cancelPendingFollowUps } from "../pipeline/queue";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Verify Resend webhook signature if RESEND_WEBHOOK_SECRET is set. */
function verifySignature(req: any): boolean {
  const secret = process.env["RESEND_WEBHOOK_SECRET"];
  if (!secret) return true; // no secret configured — allow all
  const sig = req.headers["svix-signature"] as string | undefined;
  const ts = req.headers["svix-timestamp"] as string | undefined;
  const id = req.headers["svix-id"] as string | undefined;
  if (!sig || !ts || !id) return false;

  const body = JSON.stringify(req.body);
  const toSign = `${id}.${ts}.${body}`;
  const expected = createHmac("sha256", secret).update(toSign).digest("base64");

  // sig may contain multiple space-separated signatures; check each
  const parts = sig.split(" ").map((p) => p.replace(/^v1,/, ""));
  return parts.some((part) => {
    try {
      return timingSafeEqual(Buffer.from(part, "base64"), Buffer.from(expected, "base64"));
    } catch {
      return false;
    }
  });
}

router.post("/webhooks/resend", async (req, res): Promise<void> => {
  if (!verifySignature(req)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { type, data } = req.body ?? {};
  const providerId: string | undefined = data?.email_id;

  if (!type || !providerId) {
    res.sendStatus(200);
    return;
  }

  // Look up the email by provider message ID
  const [email] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.providerMessageId, providerId));

  if (!email) {
    // Not found — might be a test or old record; acknowledge without error
    res.sendStatus(200);
    return;
  }

  const now = new Date();
  const leadId = email.leadId;
  const campaignId = email.campaignId ?? null;

  try {
    switch (type) {
      case "email.delivered":
        await db
          .update(emailsTable)
          .set({ status: "delivered", deliveredAt: now })
          .where(and(eq(emailsTable.id, email.id)));
        break;

      case "email.opened":
        if (email.status !== "replied" && email.status !== "delivered") {
          await db
            .update(emailsTable)
            .set({ status: "opened", openedAt: now })
            .where(eq(emailsTable.id, email.id));
        }
        break;

      case "email.bounced":
        await db
          .update(emailsTable)
          .set({ status: "bounced", bouncedAt: now })
          .where(eq(emailsTable.id, email.id));
        // Cancel future follow-ups for this lead
        await cancelPendingFollowUps(leadId, campaignId);
        break;

      case "email.complained":
      case "email.unsubscribed": {
        // Mark lead as globally unsubscribed
        await db
          .update(leadsTable)
          .set({ unsubscribed: true, updatedAt: now })
          .where(eq(leadsTable.id, leadId));
        await db
          .update(emailsTable)
          .set({ status: "unsubscribed" })
          .where(eq(emailsTable.id, email.id));
        await cancelPendingFollowUps(leadId, null);

        const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
        await db.insert(activitiesTable).values({
          type: "email_sent",
          description: `Désabonnement — ${lead?.firstName ?? ""} ${lead?.lastName ?? ""}`,
          leadName: `${lead?.firstName ?? ""} ${lead?.lastName ?? ""}`,
          leadId,
          campaignId,
        });
        break;
      }

      default:
        logger.info({ type, emailId: email.id }, "Unhandled Resend webhook type");
    }
  } catch (err) {
    logger.error({ err, type, emailId: email.id }, "Webhook processing error");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.sendStatus(200);
});

/**
 * POST /api/emails/:id/mark-replied
 * Manually mark an email as replied and cancel pending follow-ups.
 */
router.post("/emails/:id/mark-replied", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid email ID" });
    return;
  }

  const [email] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, id));

  if (!email) {
    res.status(404).json({ error: "Email not found" });
    return;
  }

  const now = new Date();
  const [updated] = await db
    .update(emailsTable)
    .set({ status: "replied", repliedAt: now })
    .where(eq(emailsTable.id, id))
    .returning();

  const cancelled = await cancelPendingFollowUps(email.leadId, email.campaignId ?? null);

  // Update lead stage
  await db
    .update(leadsTable)
    .set({ stage: "replied", updatedAt: now })
    .where(eq(leadsTable.id, email.leadId));

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, email.leadId));
  await db.insert(activitiesTable).values({
    type: "email_replied",
    description: `Réponse marquée — ${lead?.firstName ?? ""} ${lead?.lastName ?? ""}`,
    leadName: `${lead?.firstName ?? ""} ${lead?.lastName ?? ""}`,
    leadId: email.leadId,
    campaignId: email.campaignId ?? null,
  });

  res.json({ email: updated, cancelledFollowUps: cancelled });
});

export default router;
