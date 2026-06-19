---
name: Hunter+Dropcontact cascade
description: Cascade enrichissement email Hunter.io + Dropcontact intégré dans enrich.ts après le crawl site.
---

# Hunter + Dropcontact cascade

## Rule
After `discoverVerifiedEmail()` returns null, `enrichFromCascade(lead)` is called in `pipeline/enrich.ts`. It tries three steps in order, stopping at the first SMTP-deliverable result:
1. **hunter_domain** — domain search from lead.website hostname
2. **hunter_finder** — predicted address (requires firstName + lastName)
3. **dropcontact** — async POST → poll (max 20s, language: FR)

Every candidate is SMTP-verified (RCPT TO) before adoption. Nothing is invented.

**Why:** Hunter and Dropcontact are optional paid services. Both clients silently return null/empty when their API key (HUNTER_API_KEY / DROPCONTACT_API_KEY) is absent, or on 402/429. This makes the cascade safe to deploy with zero keys configured.

**How to apply:**
- `emailSource` column on leads tracks the winning step: `website_crawl | hunter_domain | hunter_finder | dropcontact | pre_existing`
- The `bouncedAt` timestamp column was also added to leads in the same migration (Task #17)
- API keys are optional env vars — NOT stored in DB yet; see proposed Task #24 to add settings-page config
- Dropcontact is async: POST returns `request_id`, poll `/contact/{id}` until `status !== "pending"` (2s interval, 20s max timeout)
- Hunter email finder minimum confidence threshold: score ≥ 50
