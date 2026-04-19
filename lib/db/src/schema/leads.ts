import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadStageEnum = pgEnum("lead_stage", [
  "raw",
  "enriched",
  "email_generated",
  "contacted",
  "replied",
  "converted",
  "unsubscribed",
]);

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  company: text("company").notNull(),
  jobTitle: text("job_title").notNull(),
  website: text("website"),
  linkedinUrl: text("linkedin_url"),
  phone: text("phone"),
  industry: text("industry"),
  companySize: text("company_size"),
  location: text("location"),
  stage: leadStageEnum("stage").notNull().default("raw"),
  emailValid: boolean("email_valid"),
  emailValidationReason: text("email_validation_reason"),
  isHiring: boolean("is_hiring"),
  intentSignal: text("intent_signal"),
  websiteSummary: text("website_summary"),
  websiteKeywords: text("website_keywords"),
  painPoint: text("pain_point"),
  lcapCompliant: boolean("lcap_compliant"),
  lcapReason: text("lcap_reason"),
  unsubscribeToken: text("unsubscribe_token").unique(),
  unsubscribed: boolean("unsubscribed").notNull().default(false),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  notes: text("notes"),
  campaignId: integer("campaign_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
