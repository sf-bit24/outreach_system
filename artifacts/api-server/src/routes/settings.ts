import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, senderSettingsTable } from "@workspace/db";
import { getOrCreateSenderSettings, computeWarmupLimit } from "../pipeline/queue";
import { isResendConfigured, encryptSmtpPass, sendEmail, buildLcapEmail } from "../pipeline/sender";

const router: IRouter = Router();

function buildSettingsResponse(settings: Awaited<ReturnType<typeof getOrCreateSenderSettings>>) {
  return {
    ...settings,
    smtpPassEncrypted: undefined,
    smtpConfigured: Boolean(settings.smtpPassEncrypted),
    resendConfigured: isResendConfigured(),
    warmupEffectiveLimit: computeWarmupLimit(settings),
    warmupStartDate: settings.warmupStartDate ? settings.warmupStartDate.toISOString() : null,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

router.get("/settings/sender", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSenderSettings();
  res.json(buildSettingsResponse(settings));
});

router.patch("/settings/sender", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  const {
    smtpPass,
    warmupStartDate,
    transportMode,
    smtpHost,
    smtpPort,
    smtpUser,
    warmupEnabled,
    warmupStartVolume,
    warmupIncrement,
    warmupMaxVolume,
    senderName,
    senderEmail,
    senderCompany,
    senderAddress,
    pocMessage,
    valueProposition,
    dailyLimit,
    delayMinSeconds,
    delayMaxSeconds,
    resendEnabled,
  } = body;

  const patch: Record<string, unknown> = {};

  if (typeof senderName === "string") patch.senderName = senderName;
  if (typeof senderEmail === "string") patch.senderEmail = senderEmail;
  if (typeof senderCompany === "string") patch.senderCompany = senderCompany;
  if (typeof senderAddress === "string") patch.senderAddress = senderAddress;
  if (typeof pocMessage === "string") patch.pocMessage = pocMessage;
  if (typeof valueProposition === "string") patch.valueProposition = valueProposition;
  if (typeof dailyLimit === "number") patch.dailyLimit = Math.max(1, Math.floor(dailyLimit));
  if (typeof delayMinSeconds === "number") patch.delayMinSeconds = Math.max(0, Math.floor(delayMinSeconds));
  if (typeof delayMaxSeconds === "number") patch.delayMaxSeconds = Math.max(0, Math.floor(delayMaxSeconds));
  if (typeof resendEnabled === "boolean") patch.resendEnabled = resendEnabled;

  if (typeof transportMode === "string" && ["simulation", "resend", "smtp"].includes(transportMode)) {
    patch.transportMode = transportMode;
  }
  if (typeof smtpHost === "string") patch.smtpHost = smtpHost;
  if (typeof smtpPort === "number") patch.smtpPort = Math.floor(smtpPort);
  if (typeof smtpUser === "string") patch.smtpUser = smtpUser;
  if (typeof smtpPass === "string" && smtpPass.length > 0) {
    try {
      patch.smtpPassEncrypted = encryptSmtpPass(smtpPass);
    } catch (err) {
      res.status(400).json({ error: "Impossible de chiffrer le mot de passe SMTP" });
      return;
    }
  }

  if (typeof warmupEnabled === "boolean") patch.warmupEnabled = warmupEnabled;
  if (typeof warmupStartDate === "string" && warmupStartDate) {
    const d = new Date(warmupStartDate);
    if (!isNaN(d.getTime())) patch.warmupStartDate = d;
  }
  if (typeof warmupStartVolume === "number") patch.warmupStartVolume = Math.max(1, Math.floor(warmupStartVolume));
  if (typeof warmupIncrement === "number") patch.warmupIncrement = Math.max(1, Math.floor(warmupIncrement));
  if (typeof warmupMaxVolume === "number") patch.warmupMaxVolume = Math.max(1, Math.floor(warmupMaxVolume));

  if (Object.keys(patch).length === 0) {
    const settings = await getOrCreateSenderSettings();
    res.json(buildSettingsResponse(settings));
    return;
  }

  const current = await getOrCreateSenderSettings();
  const [updated] = await db
    .update(senderSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(senderSettingsTable.id, current.id))
    .returning();
  res.json(buildSettingsResponse(updated));
});

router.post("/settings/sender/test", async (req, res): Promise<void> => {
  const settings = await getOrCreateSenderSettings();
  const to: string = typeof req.body?.to === "string" ? req.body.to : settings.senderEmail;

  const fakeEmail = {
    id: 0,
    leadId: 0,
    campaignId: null,
    subject: "Test OutreachIQ — LCAP footer vérification",
    body: `Bonjour,\n\nCeci est un email de test envoyé depuis OutreachIQ pour vérifier la configuration du transport (${settings.transportMode}).\n\nLe pied de page LCAP ci-dessous est bien inclus.`,
    status: "draft" as const,
    sentAt: null,
    scheduledAt: null,
    providerMessageId: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    openedAt: null,
    repliedAt: null,
    bouncedAt: null,
  };

  const fakeLead = {
    id: 0,
    firstName: "Test",
    lastName: "OutreachIQ",
    email: to,
    emailStatus: null,
    emailLocked: false,
    company: settings.senderCompany,
    jobTitle: null,
    phone: null,
    website: null,
    industry: null,
    source: null,
    sourceUrl: null,
    stage: "prospect" as const,
    unsubscribed: false,
    unsubscribeToken: "test-token-000",
    lcapCompliant: true,
    lcapReason: null,
    painPoint: null,
    websiteSummary: null,
    websiteKeywords: null,
    lastContactedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    hiringSignal: false,
    visibleEmail: null,
  };

  const result = await sendEmail(fakeEmail as any, fakeLead as any, settings, "test-token-000");

  const mode = settings.transportMode ?? "simulation";
  const modeLabel = mode === "smtp" ? "SMTP" : mode === "resend" ? "Resend" : "Simulation";

  res.json({
    success: result.success,
    message: result.success
      ? `Email de test envoyé via ${modeLabel} → ${to}`
      : `Échec : ${result.error}`,
    providerMessageId: result.providerMessageId,
  });
});

export default router;
