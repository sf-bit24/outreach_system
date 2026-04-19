import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";

export const scrapingProviderEnum = pgEnum("scraping_provider", [
  "apollo",
  "linkedin",
]);

export const scrapingJobStatusEnum = pgEnum("scraping_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Stores encrypted session cookies / credentials per provider.
 * `encryptedPayload` is AES-256-GCM ciphertext (iv + tag + data, base64).
 * Decrypted shape: { cookies: Cookie[], userAgent?: string, label?: string }
 */
export const scrapingCredentialsTable = pgTable("scraping_credentials", {
  id: serial("id").primaryKey(),
  provider: scrapingProviderEnum("provider").notNull(),
  label: text("label"),
  encryptedPayload: text("encrypted_payload").notNull(),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Tracks scraping jobs for traceability and rate limiting.
 * `params` holds the search parameters (keywords, locations, urls, etc).
 * `result` holds counts and any error context once finished.
 */
export const scrapingJobsTable = pgTable("scraping_jobs", {
  id: serial("id").primaryKey(),
  provider: scrapingProviderEnum("provider").notNull(),
  status: scrapingJobStatusEnum("status").notNull().default("queued"),
  params: jsonb("params").notNull(),
  result: jsonb("result"),
  itemsScraped: integer("items_scraped").notNull().default(0),
  itemsImported: integer("items_imported").notNull().default(0),
  itemsSkipped: integer("items_skipped").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ScrapingCredential = typeof scrapingCredentialsTable.$inferSelect;
export type ScrapingJob = typeof scrapingJobsTable.$inferSelect;
