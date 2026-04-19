# Plan Technique pour un Système d'Outreach Email Automatisé (Open Source & Gratuit)

## 1. Introduction

Ce dépôt documente un plan technique pour mettre en place un système d'outreach email automatisé capable d'envoyer **50 à 100 emails/jour**, en utilisant uniquement des composants **gratuits** et **open source**.

## 2. Contexte et objectifs

- Cibler des niches B2B pour la vente de services.
- Éviter les dépendances à des API payantes.
- Construire une solution robuste, modulaire et évolutive.

## 3. ICP (Ideal Customer Profile)

Niches prioritaires:

- **Comptables** (cabinet moyen, hors big four)
- **Firmes de droit** (mid-market)
- **Courtiers** (hypothécaire, immobilier, assurance vie)

## 4. Collecte de données publiques

### 4.1 REQ / Données Québec

- Source: https://www.donneesquebec.ca/recherche/dataset/registre-des-entreprises
- Données entreprises (raison sociale, adresse, NEQ, etc.), sans données personnelles sensibles.
- Traitement par scripts Python (ex: inspiration `quebec/req`).

### 4.2 Apollo.io (usage gratuit)

- Utiliser des approches d'extraction open source **uniquement** dans le respect des CGU de la plateforme, des limites de taux (rate limiting) et des restrictions anti-automatisation applicables.
- Interdire explicitement tout contournement technique des contrôles d’accès, quotas, ou mécanismes de protection.
- Cibles: entreprise, contact, rôle, email professionnel (si disponible).

### 4.3 LinkedIn public

- Collecte d'informations publiques pour enrichissement.
- Usage responsable en respectant les CGU LinkedIn et la réglementation applicable (ex.: RGPD/Loi 25 au Québec selon le contexte de traitement).
- Politique recommandée: minimisation des données, finalité explicite, conservation limitée, et suppression sur demande.

## 5. Enrichissement et validation email

### 5.1 Enrichissement

- Croisement des sources (REQ, Apollo, LinkedIn).
- Normalisation avec `pandas`.
- Ajout de contexte entreprise/contact (secteur, rôle, localisation, etc.).

### 5.2 Validation

- Validation syntaxe + domaine (`python-email-validator`, alternatives).
- Optionnel: vérifications additionnelles de délivrabilité (MX/SMTP selon politique).

## 6. Génération de phrases d'accroche

- Personnalisation à partir des données enrichies.
- Génération par module NLP/LLM open source auto-hébergé ou logique template avancée.
- Objectif: accroche courte, pertinente, contextualisée, orientée conversation.

## 7. Envoi d'emails (plateforme open source)

- Déploiement d'une solution auto-hébergée d'outreach open source.
- Cadence initiale: **50–100/jour**.
- Bonnes pratiques délivrabilité:
  - warm-up progressif
  - rotation d'identités/domaines d'envoi (si applicable)
  - suivi bounce/complaints

## 8. Architecture technique

1. **Collecte**
   - Module REQ
   - Module extraction leads
   - Module enrichissement public web
2. **Traitement**
   - Base locale (SQLite/PostgreSQL)
   - Pipeline de normalisation + enrichissement
   - Validation email
3. **Contenu**
   - Générateur d'accroches
4. **Orchestration outreach**
   - Planification envois
   - Personnalisation templates
   - Suivi réponses et relances

## 9. Principes d'accroche

- **Personnalisation**: nom entreprise/rôle/contexte.
- **Pertinence**: relier besoin prospect ↔ proposition de valeur.
- **Brevité**: message clair et court.
- **Question ouverte**: encourager l'échange.

Exemples:

- Comptable: _« J’ai vu que [Entreprise] développe activement [segment]. Comment abordez-vous aujourd’hui l’acquisition de nouveaux mandats dans ce marché? »_
- Firme de droit: _« Votre pratique en [domaine] est très visible. Seriez-vous ouvert à voir une approche d’outreach qui génère des discussions qualifiées sans augmenter la charge équipe? »_
- Courtier: _« En courtage [type], la vitesse de contact est clé. Souhaitez-vous comparer votre processus actuel à une approche automatisée orientée prospects qualifiés? »_

## 10. Roadmap d’implémentation

1. Développer modules de collecte.
2. Mettre en place base locale.
3. Implémenter enrichissement + validation.
4. Ajouter génération d’accroches.
5. Déployer outil d’envoi open source.
6. Tester et optimiser délivrabilité + taux de réponse.

## 11. Références (sources mentionnées)

- `quebec/req`: https://github.com/quebec/req
- `scrapefulldotcom/apollo-scraper`: https://github.com/scrapefulldotcom/apollo-scraper
- `FraneCal/apollo_scraper`: https://github.com/FraneCal/apollo_scraper
- `liveupx/apollo-email-scraper`: https://github.com/liveupx/apollo-email-scraper
- `maximo3k/apollo-search-scraper`: https://github.com/maximo3k/apollo-search-scraper
- `joeyism/linkedin_scraper`: https://github.com/joeyism/linkedin_scraper
- `dchrastil/ScrapedIn`: https://github.com/dchrastil/ScrapedIn
- `JoshData/python-email-validator`: https://github.com/JoshData/python-email-validator
- `BaseMax/EmailVerifier`: https://github.com/BaseMax/EmailVerifier
- `ai-cold-email-generator`: https://github.com/topics/ai-cold-email-generator
- `cold-email-generator`: https://github.com/topics/cold-email-generator
- `PaulleDemon/Email-automation`: https://github.com/PaulleDemon/Email-automation
- `OutreachStud-io/studio`: https://github.com/OutreachStud-io/studio
- `codersgyan/camp`: https://github.com/codersgyan/camp
- `useplunk/plunk`: https://github.com/useplunk/plunk
