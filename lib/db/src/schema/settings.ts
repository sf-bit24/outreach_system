import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const senderSettingsTable = pgTable("sender_settings", {
  id: serial("id").primaryKey(),
  senderName: text("sender_name").notNull().default("OutreachIQ"),
  senderEmail: text("sender_email").notNull().default("hello@example.com"),
  senderCompany: text("sender_company").notNull().default("OutreachIQ"),
  senderAddress: text("sender_address").notNull().default(""),
  pocMessage: text("poc_message")
    .notNull()
    .default(
      "C'est d'ailleurs grâce à une approche similaire que nous avons pu identifier votre entreprise et vous contacter aujourd'hui, démontrant l'efficacité de notre système.",
    ),
  valueProposition: text("value_proposition").notNull().default(""),
  dailyLimit: integer("daily_limit").notNull().default(50),
  delayMinSeconds: integer("delay_min_seconds").notNull().default(60),
  delayMaxSeconds: integer("delay_max_seconds").notNull().default(180),
  resendEnabled: boolean("resend_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSenderSettingsSchema =
  createInsertSchema(senderSettingsTable).omit({ id: true, updatedAt: true });
export type SenderSettings = typeof senderSettingsTable.$inferSelect;
export type InsertSenderSettings = z.infer<typeof insertSenderSettingsSchema>;
