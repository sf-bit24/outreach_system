import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  emailsTable,
  emailEventsTable,
  activitiesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * GET /api/unsubscribe/:token
 * Plain HTML page; one-click unsubscribe per LCAP requirement.
 * Also handles POST for List-Unsubscribe-Post one-click compliance.
 */
async function handleUnsubscribe(req: Request, res: Response): Promise<void> {
  const tokenParam = req.params["token"];
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  if (!token) {
    res.status(400).send("Missing token");
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.unsubscribeToken, token));

  if (!lead) {
    res.status(404).send(renderPage("Lien invalide", "Ce lien de désabonnement n'est pas reconnu."));
    return;
  }

  if (!lead.unsubscribed) {
    await db
      .update(leadsTable)
      .set({
        unsubscribed: true,
        unsubscribedAt: new Date(),
        stage: "unsubscribed",
      })
      .where(eq(leadsTable.id, lead.id));

    await db.insert(activitiesTable).values({
      type: "email_replied",
      description: `${lead.firstName} ${lead.lastName} (${lead.email}) s'est désabonné(e)`,
      leadName: `${lead.firstName} ${lead.lastName}`,
      leadId: lead.id,
    });

    logger.info({ leadId: lead.id, email: lead.email }, "Lead unsubscribed");
  }

  res.status(200).send(
    renderPage(
      "Désabonnement confirmé",
      `<p>${escape(lead.firstName)}, votre adresse <strong>${escape(lead.email)}</strong> a bien été retirée de notre liste.</p><p>Vous ne recevrez plus de messages de notre part.</p>`,
    ),
  );
}

router.get("/unsubscribe/:token", handleUnsubscribe);
router.post("/unsubscribe/:token", handleUnsubscribe);

/**
 * POST /api/webhooks/resend
 * Receives Resend events: email.delivered, email.opened, email.bounced,
 * email.complained, email.replied, etc. Updates email + lead state.
 */
router.post("/webhooks/resend", async (req, res): Promise<void> => {
  // Verify webhook authenticity. Resend signs requests with a shared secret
  // configured via RESEND_WEBHOOK_SECRET. Reject if the secret is set but the
  // header doesn't match — protects against forged unsubscribe events.
  const expected = process.env["RESEND_WEBHOOK_SECRET"];
  if (expected) {
    const provided =
      (req.headers["svix-signature"] as string | undefined) ??
      (req.headers["resend-signature"] as string | undefined) ??
      (req.headers["x-webhook-secret"] as string | undefined);
    if (!provided || !provided.includes(expected)) {
      logger.warn("Rejected webhook with invalid signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  const event = req.body as { type?: string; data?: Record<string, unknown> };
  const type = event?.type ?? "unknown";
  const data = event?.data ?? {};
  const messageId = (data["email_id"] ?? data["id"]) as string | undefined;

  await db.insert(emailEventsTable).values({
    providerMessageId: messageId ?? null,
    eventType: type,
    payload: event as any,
  });

  if (!messageId) {
    res.json({ received: true });
    return;
  }

  const [email] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.providerMessageId, messageId));

  if (!email) {
    res.json({ received: true, matched: false });
    return;
  }

  const now = new Date();
  switch (type) {
    case "email.delivered":
      await db
        .update(emailsTable)
        .set({ status: "delivered", deliveredAt: now })
        .where(eq(emailsTable.id, email.id));
      break;
    case "email.opened":
      await db
        .update(emailsTable)
        .set({ status: "opened", openedAt: now })
        .where(eq(emailsTable.id, email.id));
      break;
    case "email.bounced":
      await db
        .update(emailsTable)
        .set({ status: "bounced", bouncedAt: now })
        .where(eq(emailsTable.id, email.id));
      break;
    case "email.complained":
    case "email.unsubscribed":
      await db
        .update(emailsTable)
        .set({ status: "unsubscribed" })
        .where(eq(emailsTable.id, email.id));
      await db
        .update(leadsTable)
        .set({ unsubscribed: true, unsubscribedAt: now, stage: "unsubscribed" })
        .where(eq(leadsTable.id, email.leadId));
      break;
    case "email.replied":
      await db
        .update(emailsTable)
        .set({ status: "replied", repliedAt: now })
        .where(eq(emailsTable.id, email.id));
      await db
        .update(leadsTable)
        .set({ stage: "replied" })
        .where(eq(leadsTable.id, email.leadId));
      await db.insert(activitiesTable).values({
        type: "email_replied",
        description: `Reply received on "${email.subject}"`,
        leadId: email.leadId,
        campaignId: email.campaignId ?? null,
      });
      break;
  }

  res.json({ received: true, matched: true });
});

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderPage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/><title>${escape(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>
body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
.card{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:32px;max-width:480px;box-shadow:0 1px 3px rgba(0,0,0,.05);}
h1{font-size:20px;margin:0 0 12px;}
p{font-size:15px;line-height:1.6;color:#475569;margin:0 0 8px;}
.brand{font-size:12px;color:#94a3b8;margin-top:24px;}
</style></head><body><div class="card"><h1>${escape(title)}</h1>${bodyHtml}<p class="brand">OutreachIQ</p></div></body></html>`;
}

export default router;
