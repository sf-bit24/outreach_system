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

export const emailStatusEnum = pgEnum("email_status", [
  "draft",
  "queued",
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
  "failed",
  "unsubscribed",
]);

export const emailsTable = pgTable("emails", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  campaignId: integer("campaign_id"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  hook: text("hook"),
  providerMessageId: text("provider_message_id"),
  errorMessage: text("error_message"),
  status: emailStatusEnum("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertEmailSchema = createInsertSchema(emailsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEmail = z.infer<typeof insertEmailSchema>;
export type Email = typeof emailsTable.$inferSelect;

export const emailEventsTable = pgTable("email_events", {
  id: serial("id").primaryKey(),
  emailId: integer("email_id"),
  providerMessageId: text("provider_message_id"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type EmailEvent = typeof emailEventsTable.$inferSelect;
