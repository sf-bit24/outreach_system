/**
 * IMAP bounce detector — polls the sender's inbox every 15 minutes looking for
 * Delivery Status Notification (DSN, RFC 3464) messages and marks the
 * corresponding lead as bounced.
 *
 * Activated only when `bounceDetectionEnabled=true` AND `transportMode='smtp'`.
 * Silently skips on any IMAP connection error.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db, leadsTable, activitiesTable } from "@workspace/db";
import type { SenderSettings } from "@workspace/db";
import { eq, and, or } from "drizzle-orm";
import { decryptSmtpPass } from "./sender";
import { logger } from "../lib/logger";

// Subject keywords that indicate a DSN / bounce email
const DSN_SUBJECT_KEYWORDS = [
  "delivery status notification",
  "mail delivery failed",
  "undelivered mail returned",
  "delivery failure",
  "failure notice",
  "non-delivery report",
  "message not delivered",
  "retour en cas de non-remise",
  "échec de distribution",
  "delivery report",
  "bounce",
];

function isDsnSubject(subject: string): boolean {
  const lower = subject.toLowerCase();
  return DSN_SUBJECT_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Try to extract the bounced email address from a raw DSN message source.
 * Tries multiple heuristics in order.
 */
async function extractBouncedEmail(source: Buffer): Promise<string | null> {
  let parsed;
  try {
    parsed = await simpleParser(source);
  } catch {
    return null;
  }

  // 1. x-failed-recipients header (set by Postfix, Exim, Exchange)
  const xFailed = parsed.headers.get("x-failed-recipients");
  if (typeof xFailed === "string") {
    const candidate = xFailed.trim().toLowerCase().split(/[\s,;]+/)[0];
    if (candidate && candidate.includes("@")) return candidate;
  }

  // 2. Parse message/delivery-status MIME part (the canonical RFC 3464 source)
  //    mailparser exposes it as an attachment with contentType message/delivery-status
  for (const attachment of parsed.attachments ?? []) {
    const ct = attachment.contentType ?? "";
    if (!ct.includes("delivery-status") && !ct.includes("message/delivery-status"))
      continue;

    const text = attachment.content.toString("utf8");

    // Final-Recipient: rfc822; user@domain.com
    const finalMatch = text.match(
      /Final-Recipient:\s*(?:rfc822;\s*)?([^\s\r\n<>]+@[^\s\r\n<>]+)/i,
    );
    if (finalMatch) {
      return finalMatch[1].trim().toLowerCase();
    }

    // Original-Recipient: rfc822; user@domain.com
    const origMatch = text.match(
      /Original-Recipient:\s*(?:rfc822;\s*)?([^\s\r\n<>]+@[^\s\r\n<>]+)/i,
    );
    if (origMatch) {
      return origMatch[1].trim().toLowerCase();
    }
  }

  // 3. Fallback: look for patterns in the plain-text body
  const bodyText = parsed.text ?? "";
  const bodyMatch = bodyText.match(
    /(?:final recipient|failed recipient|originally sent to|could not be delivered to)[:\s]+<?([^\s\r\n<>]+@[^\s\r\n<>]+)>?/i,
  );
  if (bodyMatch) {
    return bodyMatch[1].trim().toLowerCase();
  }

  return null;
}

/**
 * Derive the IMAP host from SMTP host when not explicitly configured.
 * smtp.hostinger.com → imap.hostinger.com
 * smtp.gmail.com     → imap.gmail.com
 * mail.example.com   → mail.example.com  (no prefix change)
 */
function deriveImapHost(settings: SenderSettings): string | null {
  if (settings.imapHost) return settings.imapHost;
  if (!settings.smtpHost) return null;
  return settings.smtpHost.replace(/^smtp\./i, "imap.");
}

/**
 * Poll the IMAP inbox for unread DSN messages and mark bounced leads.
 * Maximum 20 messages processed per run (to bound latency).
 */
export async function pollBounces(settings: SenderSettings): Promise<void> {
  if (!settings.bounceDetectionEnabled) return;
  if (settings.transportMode !== "smtp") return;
  if (!settings.smtpUser || !settings.smtpPassEncrypted) {
    logger.warn("Bounce detection: SMTP credentials missing — skipping");
    return;
  }

  const imapHost = deriveImapHost(settings);
  if (!imapHost) {
    logger.warn("Bounce detection: no IMAP host derivable — skipping");
    return;
  }

  let pass: string;
  try {
    pass = decryptSmtpPass(settings.smtpPassEncrypted);
  } catch {
    logger.warn("Bounce detection: failed to decrypt SMTP password — skipping");
    return;
  }

  const client = new ImapFlow({
    host: imapHost,
    port: settings.imapPort,
    secure: settings.imapPort === 993,
    auth: { user: settings.smtpUser, pass },
    logger: false, // suppress verbose imapflow output
  });

  try {
    await client.connect();
  } catch (err) {
    logger.warn({ err, imapHost }, "Bounce detection: IMAP connection failed — skipping");
    return;
  }

  let bounceCount = 0;

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Get UIDs of unread messages (limit to 20 most recent)
      const rawUids = await client.search({ seen: false }, { uid: true });
      // imapflow returns `false` when the mailbox has no messages
      const allUids: number[] = Array.isArray(rawUids) ? rawUids : [];
      if (allUids.length === 0) {
        logger.info({ imapHost }, "Bounce detection: no unread messages");
        return;
      }

      const candidateUids = allUids.slice(-20);
      logger.info(
        { imapHost, total: allUids.length, checking: candidateUids.length },
        "Bounce detection: scanning unread messages",
      );

      // Fetch subject/envelope first to filter cheaply
      const dsnUids: number[] = [];
      const envelopeFetch = client.fetch(
        candidateUids.join(","),
        { uid: true, envelope: true },
        { uid: true },
      );
      for await (const msg of envelopeFetch) {
        if (msg.envelope?.subject && isDsnSubject(msg.envelope.subject)) {
          dsnUids.push(msg.uid);
        }
      }

      if (dsnUids.length === 0) {
        logger.info({ imapHost }, "Bounce detection: no DSN subjects found");
        return;
      }

      logger.info(
        { imapHost, dsnCount: dsnUids.length },
        "Bounce detection: DSN candidates identified",
      );

      // Fetch full source for DSN candidates only
      for (const uid of dsnUids) {
        const raw = await client.fetchOne(uid.toString(), { source: true }, { uid: true });
        // imapflow returns `false` when the message is not found
        if (!raw) continue;
        const msg = raw;
        if (!msg.source) continue;

        const bouncedEmail = await extractBouncedEmail(msg.source as unknown as Buffer);
        if (!bouncedEmail) {
          // Mark as read even if we couldn't parse it, to avoid re-processing
          await client.messageFlagsAdd(uid.toString(), ["\\Seen"], { uid: true });
          continue;
        }

        logger.info({ bouncedEmail, uid }, "Bounce detection: found bounced email");

        // Look up lead by email
        const [lead] = await db
          .select({ id: leadsTable.id, firstName: leadsTable.firstName, lastName: leadsTable.lastName, email: leadsTable.email })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.email, bouncedEmail),
              or(eq(leadsTable.emailStatus, "verified"), eq(leadsTable.emailStatus, "sent")),
            ),
          );

        if (lead) {
          await db
            .update(leadsTable)
            .set({
              emailStatus: "bounced",
              emailLocked: true,
              bouncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(leadsTable.id, lead.id));

          await db.insert(activitiesTable).values({
            type: "lead_enriched",
            description: `Bounce détecté : ${bouncedEmail} → lead marqué bounced`,
            leadName: `${lead.firstName} ${lead.lastName}`,
            leadId: lead.id,
          });

          logger.info(
            { leadId: lead.id, email: bouncedEmail },
            "Bounce detection: lead marked as bounced",
          );
          bounceCount++;
        } else {
          logger.info(
            { bouncedEmail },
            "Bounce detection: no matching verified lead found",
          );
        }

        // Mark the IMAP message as read regardless of whether a lead was found
        await client.messageFlagsAdd(uid.toString(), ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err, imapHost }, "Bounce detection: error during polling");
  } finally {
    await client.logout().catch(() => {});
  }

  if (bounceCount > 0) {
    logger.info({ bounceCount }, "Bounce detection: run complete");
  }
}

/**
 * Start the 15-minute bounce polling interval.
 * Does nothing if called when bounceDetectionEnabled=false; the pollBounces
 * function checks the flag on each invocation so toggling the setting takes
 * effect without restarting the server.
 */
export function initBouncePoller(getSettings: () => Promise<SenderSettings>): void {
  const run = () =>
    getSettings()
      .then((s) => pollBounces(s))
      .catch((err) => logger.error({ err }, "Bounce poller error"));

  // First run after 1 minute (let the server warm up)
  setTimeout(run, 60_000);

  // Then every 15 minutes
  setInterval(run, 15 * 60_000);

  logger.info("Bounce detection poller initialised (15 min interval)");
}
