# OutreachIQ

## Overview
OutreachIQ is an intelligent B2B outreach automation system implementing the
4-stage ethical prospecting pipeline described in the French-language blueprints
in `attached_assets/`. It is built on the pnpm monorepo template.

## Pipeline (4 stages)
1. **Data Acquisition** — leads imported manually or in bulk via `/api/leads/import`.
2. **Enrichment & Validation** — `/api/leads/:id/enrich` runs in parallel:
   - DNS MX-record + syntax + disposable/role validation (`pipeline/emailValidator.ts`)
   - Cheerio website scraping → summary, top keywords, visible-email check (`pipeline/websiteScraper.ts`)
   - Hiring-signal detection on `/careers`, `/jobs`, `/recrutement` etc.
   - LCAP (Loi C-28 / CASL) compliance assessment (`pipeline/lcap.ts`).
3. **AI Personalization** — `/api/emails/generate` runs a 3-stage French LLM
   pipeline (analyze pain → write hook → write body) in `pipeline/aiPersonalization.ts`.
   Untrusted scraped data is sanitized before being sent to the LLM.
4. **Sending Orchestration** — `pipeline/queue.ts` enforces a daily limit and
   randomized 60–180s delays. `pipeline/sender.ts` sends via Resend (when
   `RESEND_API_KEY` + `senderSettings.resendEnabled`) and falls back to a
   simulation mode otherwise. Every email contains an LCAP footer + `List-Unsubscribe`
   headers. Resend webhooks (`/api/webhooks/resend`, optionally signed via
   `RESEND_WEBHOOK_SECRET`) update delivery / open / reply / bounce / unsubscribe state.

## Artifacts
- `artifacts/api-server` — Express + Drizzle backend (port from `PORT` env)
- `artifacts/outreach` — React + Vite UI (Dashboard, Leads, Lead Detail, Campaigns,
  Campaign Detail, Emails)
- `artifacts/mockup-sandbox` — design previews (template default)

## Database
PostgreSQL via `DATABASE_URL`. Schema in `lib/db/src/schema/`:
- `leadsTable` — full prospect record incl. LCAP fields (`lcapCompliant`,
  `lcapReason`), `unsubscribeToken`, `painPoint`, `websiteSummary`, `websiteKeywords`.
- `senderSettingsTable` — single-row global sender identity, POC message,
  daily limit, send delays, Resend toggle.
- `campaignsTable`, `emailsTable` (with `queued/delivered/bounced/failed/unsubscribed`
  statuses + `providerMessageId`), `emailEventsTable`, `activitiesTable`.

Run `pnpm --filter @workspace/db run push` after schema edits.

## Environment
- `DATABASE_URL` — Postgres
- `SESSION_SECRET`
- `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` — auto-set
- `RESEND_API_KEY` — optional; missing means simulation mode
- `RESEND_WEBHOOK_SECRET` — optional; if set, webhook signature is enforced
- `REPLIT_DEV_DOMAIN` — used to build the public unsubscribe URL

## API model
`gpt-5.2` with `max_completion_tokens: 8192`, no temperature.

## Codegen
After editing `lib/api-spec/openapi.yaml`, run:
`pnpm --filter @workspace/api-spec run codegen`
The script regenerates `lib/api-zod/src/generated/api.ts`. Server routes do
**not** call `Response.parse()` on outgoing JSON (the generated schemas use
`z.string()` for date fields, but Drizzle returns `Date` objects).
