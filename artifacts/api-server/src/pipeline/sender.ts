import { Resend } from "resend";
import nodemailer from "nodemailer";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { Lead, SenderSettings, Email } from "@workspace/db";
import { logger } from "../lib/logger";

// ─── SMTP password encryption (AES-256-GCM, key derived from SESSION_SECRET) ───

function deriveKey(): Buffer {
  const secret = process.env["SESSION_SECRET"] ?? "default-outreachiq-key-change-me";
  return createHash("sha256").update(secret).digest();
}

export function encryptSmtpPass(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSmtpPass(encrypted: string): string {
  const key = deriveKey();
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

// ─── Resend client ───

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return null;
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

export function isResendConfigured(): boolean {
  return Boolean(process.env["RESEND_API_KEY"]);
}

// ─── Helpers ───

function buildPublicBaseUrl(): string {
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  if (dev) return `https://${dev}`;
  return process.env["PUBLIC_BASE_URL"] ?? "http://localhost";
}

export function buildLcapEmail(
  email: Email,
  lead: Lead,
  settings: SenderSettings,
  unsubscribeToken: string,
): { html: string; text: string } {
  const base = buildPublicBaseUrl();
  const unsubUrl = `${base}/api/unsubscribe/${unsubscribeToken}`;
  const senderBlock = [
    settings.senderName,
    settings.senderCompany,
    settings.senderAddress,
    settings.senderEmail,
  ]
    .filter(Boolean)
    .join(" · ");

  const text = `${email.body}

---
${senderBlock}

Conformément à la LCAP (Loi C-28), vous pouvez vous désabonner à tout moment en cliquant ici: ${unsubUrl}`;

  const escapedBody = email.body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const bodyHtml = escapedBody
    .split(/\n\n+/)
    .map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.55;max-width:560px;margin:0 auto;padding:16px;">
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;"/>
<p style="font-size:12px;color:#6b7280;margin:0 0 6px;">${senderBlock}</p>
<p style="font-size:12px;color:#6b7280;margin:0;">Conformément à la LCAP (Loi C-28), vous pouvez <a href="${unsubUrl}" style="color:#6b7280;">vous désabonner</a> à tout moment.</p>
</body></html>`;

  return { html, text };
}

// ─── Send result ───

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  simulated?: boolean;
}

const ALLOWED_STATUSES: ReadonlyArray<string | null> = [null, "verified"];

function guardEmail(lead: Lead): string | null {
  if (!lead.email || lead.emailLocked || !ALLOWED_STATUSES.includes(lead.emailStatus ?? null)) {
    return `Lead email not verified (email=${lead.email ?? "null"}, status=${lead.emailStatus ?? "null"}, locked=${lead.emailLocked}). Run enrichment before sending.`;
  }
  return null;
}

// ─── SMTP transport ───

export async function sendEmailViaSmtp(
  email: Email,
  lead: Lead,
  settings: SenderSettings,
  unsubscribeToken: string,
): Promise<SendResult> {
  const guard = guardEmail(lead);
  if (guard) return { success: false, error: guard };

  if (!settings.smtpHost || !settings.smtpUser || !settings.smtpPassEncrypted) {
    return { success: false, error: "SMTP non configuré (hôte / utilisateur / mot de passe manquants)" };
  }

  let pass: string;
  try {
    pass = decryptSmtpPass(settings.smtpPassEncrypted);
  } catch {
    return { success: false, error: "Impossible de déchiffrer le mot de passe SMTP" };
  }

  const port = settings.smtpPort ?? 587;
  const transport = nodemailer.createTransport({
    host: settings.smtpHost,
    port,
    secure: port === 465,
    auth: { user: settings.smtpUser, pass },
    tls: { rejectUnauthorized: true },
  });

  const { html, text } = buildLcapEmail(email, lead, settings, unsubscribeToken);
  const base = buildPublicBaseUrl();
  const unsubUrl = `${base}/api/unsubscribe/${unsubscribeToken}`;
  const from = `${settings.senderName} <${settings.senderEmail}>`;

  try {
    const info = await transport.sendMail({
      from,
      to: lead.email!,
      subject: email.subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return { success: true, providerMessageId: info.messageId };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Resend transport ───

export async function sendEmailViaResend(
  email: Email,
  lead: Lead,
  settings: SenderSettings,
  unsubscribeToken: string,
): Promise<SendResult> {
  const guard = guardEmail(lead);
  if (guard) return { success: false, error: guard };

  const { html, text } = buildLcapEmail(email, lead, settings, unsubscribeToken);
  const from = `${settings.senderName} <${settings.senderEmail}>`;

  const client = getResend();
  if (!client || !settings.resendEnabled) {
    logger.info(
      { emailId: email.id, leadId: lead.id, to: lead.email },
      "Resend not configured — email recorded as sent (simulation mode)",
    );
    return {
      success: true,
      simulated: true,
      providerMessageId: `sim_${Date.now()}_${email.id}`,
    };
  }

  try {
    const result = await client.emails.send({
      from,
      to: lead.email!,
      subject: email.subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": `<${buildPublicBaseUrl()}/api/unsubscribe/${unsubscribeToken}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (result.error) {
      return { success: false, error: result.error.message };
    }
    return { success: true, providerMessageId: result.data?.id };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Unified dispatch ───

export async function sendEmail(
  email: Email,
  lead: Lead,
  settings: SenderSettings,
  unsubscribeToken: string,
): Promise<SendResult> {
  const mode = settings.transportMode ?? "simulation";

  if (mode === "smtp") {
    return sendEmailViaSmtp(email, lead, settings, unsubscribeToken);
  }

  if (mode === "resend") {
    return sendEmailViaResend(email, lead, settings, unsubscribeToken);
  }

  // simulation
  logger.info(
    { emailId: email.id, leadId: lead.id, to: lead.email },
    "Transport simulation — email non envoyé réellement",
  );
  return {
    success: true,
    simulated: true,
    providerMessageId: `sim_${Date.now()}_${email.id}`,
  };
}
