---
name: Email enrichment & SMTP verification
description: How LinkedIn/no-email leads get a real, verified email; the "never invent, never trust unverified" rule.
---

# Email enrichment & SMTP verification

The enrichment pipeline (`pipeline/enrich.ts` `enrichLead`) sources a real email
for leads that have none (LinkedIn/GMaps) by crawling the company website's
contact/legal/about pages (`findContactEmails` in `websiteScraper.ts`) and then
confirming each candidate with an SMTP RCPT TO probe (`verifyEmailSmtp` in
`emailValidator.ts`).

**Hard rule — only `deliverable` promotes to `email_status='verified'`.**
verifyEmailSmtp returns `deliverable | undeliverable | risky | unknown`.
- `risky` = catch-all domain (a random control address was also accepted) → never trusted.
- `unknown` = port blocked / timeout / greylisting (4xx) → never trusted.
**Why:** the whole product promise is "no invented emails, nothing sent to an
unconfirmed mailbox." A lead with no verifiable email must stay blocked.

**Catch-all detection:** every probe also RCPTs a random `no-such-user-*@domain`.
If both the target and the random address are accepted, it's a catch-all → risky.

**Obfuscation parsing is bracket-only.** `deobfuscate()` rewrites `info [at] x [dot] com`
but ONLY when the at/dot are wrapped in brackets/parens. An earlier version made the
surrounding whitespace optional, which matched "at"/"dot" *inside* ordinary words
("static" → "st@ic.fsf.org"). Never loosen this back to optional delimiters.

**Environment:** outbound port 25 is OPEN in the Replit dev container, so real RCPT
verification works. Set `SMTP_VERIFY_DRY_RUN=1` to bypass the network probe for tests
(valid-looking locals → deliverable; locals containing invalid/nonexistent → undeliverable).
HELO host comes from `SMTP_HELO_HOST` → `REPLIT_DEV_DOMAIN` → `outreachiq.app`;
MAIL FROM from `SMTP_VERIFY_FROM` → `verify@<helo>`.

**Trigger points:** the `/leads/:id/enrich` route delegates to `enrichLead`; the scraping
job runner fires `enrichLeadInBackground` for freshly-imported LinkedIn leads (best-effort,
serialized). LinkedIn leads with no `website` field can't be enriched for email yet — they
stay blocked (website discovery from company name is not implemented).
