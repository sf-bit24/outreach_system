import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "active",
  "paused",
  "completed",
]);

/**
 * One step in a follow-up sequence.
 * delayDays: days after the previous step to wait before sending.
 */
export interface SequenceStep {
  delayDays: number;
  subject: string;
  body: string;
}

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: campaignStatusEnum("status").notNull().default("draft"),
  emailSubject: text("email_subject"),
  emailTemplate: text("email_template"),
  sendingDelayMinutes: integer("sending_delay_minutes").notNull().default(60),
  dailyLimit: integer("daily_limit").notNull().default(50),
  /** Optional follow-up steps — each fires after delayDays from the prior send. */
  sequenceSteps: jsonb("sequence_steps").$type<SequenceStep[]>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
