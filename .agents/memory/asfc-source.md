---
name: ASFC customs broker source
description: How the ASFC source is implemented and what the data looks like.
---

# ASFC Customs Broker Source

**URL:** `https://www.cbsa-asfc.gc.ca/services/cb-cd/cb-cd-fra.html`

**Why:** Single government page, updated regularly (last seen 2026-05-28), publishes a 3-column HTML table: Nom | Site Web | Adresse courriel. No auth, no pagination, no rate limits. ~416 rows, ~381 with real email addresses.

**How to apply:** `POST /api/sources/asfc/import` — fetches and cheerio-parses the table. Leads get `source='asfc'`, `emailStatus='scraped'`, `emailLocked=false`, `industry='Douanes & Logistique'`. Rows without email are skipped (35 had "Sans objet"). Returns `{imported, skipped, total, errors}`.

**Why:** Emails on a .gc.ca government page are considered publicly published → qualifies for LCAP "publication manifeste" exemption. Still flows through enrichment/verification before sending.
