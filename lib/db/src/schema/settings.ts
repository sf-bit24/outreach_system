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

  transportMode: text("transport_mode").notNull().default("simulation"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpUser: text("smtp_user"),
  smtpPassEncrypted: text("smtp_pass_encrypted"),

  warmupEnabled: boolean("warmup_enabled").notNull().default(false),
  warmupStartDate: timestamp("warmup_start_date", { withTimezone: true }),
  warmupStartVolume: integer("warmup_start_volume").notNull().default(5),
  warmupIncrement: integer("warmup_increment").notNull().default(5),
  warmupMaxVolume: integer("warmup_max_volume").notNull().default(50),

  bounceDetectionEnabled: boolean("bounce_detection_enabled").notNull().default(false),
  imapHost: text("imap_host"),
  imapPort: integer("imap_port").notNull().default(993),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSenderSettingsSchema =
  createInsertSchema(senderSettingsTable).omit({ id: true, updatedAt: true });
export type SenderSettings = typeof senderSettingsTable.$inferSelect;
export type InsertSenderSettings = z.infer<typeof insertSenderSettingsSchema>;
