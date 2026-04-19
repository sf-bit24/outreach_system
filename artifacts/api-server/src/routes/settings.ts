import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, senderSettingsTable } from "@workspace/db";
import { getOrCreateSenderSettings } from "../pipeline/queue";
import { isResendConfigured } from "../pipeline/sender";
import { UpdateSenderSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/settings/sender", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSenderSettings();
  res.json({
    ...settings,
    resendConfigured: isResendConfigured(),
  });
});

router.patch("/settings/sender", async (req, res): Promise<void> => {
  const parsed = UpdateSenderSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const current = await getOrCreateSenderSettings();
  const [updated] = await db
    .update(senderSettingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(senderSettingsTable.id, current.id))
    .returning();
  res.json({
    ...updated,
    resendConfigured: isResendConfigured(),
  });
});

export default router;
