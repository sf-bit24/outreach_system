import { Resend } from "resend";
import type { Lead, SenderSettings, Email } from "@workspace/db";
import { logger } from "../lib/logger";

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
  const bodyHtml = escapedBody.split(/\n\n+/).map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, "<br/>")}</p>`).join("");

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.55;max-width:560px;margin:0 auto;padding:16px;">
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;"/>
<p style="font-size:12px;color:#6b7280;margin:0 0 6px;">${senderBlock}</p>
<p style="font-size:12px;color:#6b7280;margin:0;">Conformément à la LCAP (Loi C-28), vous pouvez <a href="${unsubUrl}" style="color:#6b7280;">vous désabonner</a> à tout moment.</p>
</body></html>`;

  return { html, text };
}

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  simulated?: boolean;
}

export async function sendEmailViaResend(
  email: Email,
  lead: Lead,
  settings: SenderSettings,
  unsubscribeToken: string,
): Promise<SendResult> {
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
      to: lead.email,
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
    return {
      success: true,
      providerMessageId: result.data?.id,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
