import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, senderSettingsTable } from "@workspace/db";
import { getOrCreateSenderSettings, computeWarmupLimit } from "../pipeline/queue";
import { isResendConfigured, encryptSmtpPass, sendEmail, buildLcapEmail } from "../pipeline/sender";
import { nextRunAt, runNightlyEnrichment, runNightlyAssign, runNightlyAcquisition } from "../pipeline/autoPipeline";

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
    // IMAP bounce detection
    bounceDetectionEnabled: settings.bounceDetectionEnabled,
    imapHost: settings.imapHost ?? null,
    imapPort: settings.imapPort,
    // Auto-pipeline
    autoPipelineEnabled: settings.autoPipelineEnabled,
    autoAcquireCategories: (settings.autoAcquireCategories as string[]) ?? [],
    autoAcquireCities: (settings.autoAcquireCities as string[]) ?? [],
    autoAcquireMaxPerRun: settings.autoAcquireMaxPerRun,
    autoAssignCampaignId: settings.autoAssignCampaignId ?? null,
    lastAutoRunAt: settings.lastAutoRunAt ? settings.lastAutoRunAt.toISOString() : null,
    lastAutoRunSummary: settings.lastAutoRunSummary ?? null,
    lastAutoAcquisitionAt: settings.lastAutoAcquisitionAt ? settings.lastAutoAcquisitionAt.toISOString() : null,
    lastAutoAcquisitionSummary: settings.lastAutoAcquisitionSummary ?? null,
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

  const {
    bounceDetectionEnabled,
    imapHost,
    imapPort,
  } = body as Record<string, unknown>;
  if (typeof bounceDetectionEnabled === "boolean") patch.bounceDetectionEnabled = bounceDetectionEnabled;
  if (typeof imapHost === "string") patch.imapHost = imapHost || null;
  if (typeof imapPort === "number") patch.imapPort = Math.max(1, Math.floor(imapPort));

  const {
    autoPipelineEnabled,
    autoAcquireCategories,
    autoAcquireCities,
    autoAcquireMaxPerRun,
    autoAssignCampaignId,
  } = body as Record<string, unknown>;
  if (typeof autoPipelineEnabled === "boolean") patch.autoPipelineEnabled = autoPipelineEnabled;
  if (Array.isArray(autoAcquireCategories)) {
    patch.autoAcquireCategories = autoAcquireCategories.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  }
  if (Array.isArray(autoAcquireCities)) {
    patch.autoAcquireCities = autoAcquireCities.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  }
  if (typeof autoAcquireMaxPerRun === "number") patch.autoAcquireMaxPerRun = Math.max(1, Math.floor(autoAcquireMaxPerRun));
  if (typeof autoAssignCampaignId === "number") patch.autoAssignCampaignId = Math.floor(autoAssignCampaignId);
  if (autoAssignCampaignId === null) patch.autoAssignCampaignId = null;

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

router.get("/settings/pipeline-status", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSenderSettings();
  res.json({
    autoPipelineEnabled: settings.autoPipelineEnabled,
    lastAutoRunAt: settings.lastAutoRunAt ? settings.lastAutoRunAt.toISOString() : null,
    lastAutoRunSummary: settings.lastAutoRunSummary ?? null,
    lastAutoAcquisitionAt: settings.lastAutoAcquisitionAt ? settings.lastAutoAcquisitionAt.toISOString() : null,
    lastAutoAcquisitionSummary: settings.lastAutoAcquisitionSummary ?? null,
    nextRunAt: nextRunAt(),
  });
});

/**
 * POST /api/pipeline/trigger
 * Déclenche manuellement une ou plusieurs phases du pipeline auto.
 * Body: { phase: "acquire" | "enrich" | "assign" | "all" }
 *
 * Répond immédiatement avec { started: true } puis exécute en arrière-plan.
 * Utiliser GET /api/settings/pipeline-status pour suivre la progression.
 */
router.post("/pipeline/trigger", (req, res): void => {
  const phase = (req.body as { phase?: string }).phase ?? "all";
  const logger = req.log;

  // Fire and forget — respond immediately
  res.json({ started: true, phase });

  (async () => {
    try {
      if (phase === "acquire" || phase === "all") {
        const r = await runNightlyAcquisition();
        logger.info(r, "Manual trigger: acquisition done");
      }
      if (phase === "enrich" || phase === "all") {
        const r = await runNightlyEnrichment();
        logger.info(r, "Manual trigger: enrichment done");
      }
      if (phase === "assign" || phase === "all") {
        const r = await runNightlyAssign();
        logger.info(r, "Manual trigger: assign done");
      }
    } catch (err) {
      logger.error({ err }, "Manual trigger: error in background phase");
    }
  })();
});

export default router;
