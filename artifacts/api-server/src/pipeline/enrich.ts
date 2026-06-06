import { db, leadsTable, activitiesTable } from "@workspace/db";
import type { Lead } from "@workspace/db";
import { eq } from "drizzle-orm";
import { validateEmail, verifyEmailSmtp } from "./emailValidator";
import {
  analyzeWebsite,
  detectHiringSignal,
  findContactEmails,
} from "./websiteScraper";
import { assessLcap, generateUnsubscribeToken } from "./lcap";
import { logger } from "../lib/logger";

export interface EnrichResult {
  lead: Lead;
  /** A real, SMTP-verified email was sourced and the lead is now sendable. */
  emailVerified: boolean;
  /** Human-readable note about what happened to the email during enrichment. */
  emailNote: string;
}

/**
 * Decide whether a lead's email step should look for a brand-new address.
 * LinkedIn / Google Maps leads arrive with no email (or a non-verified scraped
 * one) — those are the ones we try to source a real address for.
 */
function shouldDiscoverEmail(existing: Lead): boolean {
  if (!existing.email) return true;
  // A scraped-but-unverified address can still be wrong; only keep it as-is if
  // it was already promoted to "verified".
  return existing.emailStatus !== "verified";
}

/**
 * Try to source a real, deliverable email for a lead from its company website
 * and confirm it via SMTP RCPT TO. Returns the chosen address (lowercased) plus
 * the page it was published on, or null when nothing verifiable was found.
 *
 * NEVER invents an address: an email is only returned after it both passes
 * syntax/MX validation AND is reported `deliverable` by the SMTP probe.
 */
async function discoverVerifiedEmail(
  website: string | null,
  leadId: number,
): Promise<{
  email: string;
  foundOn: string;
  note: string;
} | null> {
  if (!website) return null;

  const { candidates, pagesChecked } = await findContactEmails(website);
  logger.info(
    { leadId, found: candidates.length, pagesChecked: pagesChecked.length },
    "Contact-page email discovery complete",
  );
  if (candidates.length === 0) return null;

  // Walk candidates best-first; the first that is syntactically valid, has MX,
  // and is confirmed deliverable by SMTP wins. Stop after a few attempts to
  // bound the number of SMTP conversations per enrichment.
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= 5) break;
    attempts++;

    const syntax = await validateEmail(candidate.email);
    if (!syntax.valid) continue;

    const smtp = await verifyEmailSmtp(candidate.email);
    logger.info(
      { leadId, email: candidate.email, status: smtp.status, code: smtp.code },
      "SMTP verification result",
    );
    if (smtp.status === "deliverable") {
      return {
        email: candidate.email,
        foundOn: candidate.foundOn,
        note: `Email réel trouvé sur ${candidate.foundOn} et vérifié par SMTP (RCPT TO).`,
      };
    }
  }

  return null;
}

/**
 * Run the full 4-stage enrichment pipeline for a single lead:
 *   1. Website analysis (summary / keywords / LCAP visibility)
 *   2. Hiring-signal detection
 *   3. Email sourcing + validation:
 *        - leads without a verified email → crawl the company site for a
 *          published address and confirm it via SMTP before adopting it.
 *        - leads with an existing email → validate + SMTP verify it.
 *   4. LCAP compliance assessment.
 *
 * The lead is promoted to `email_status='verified'` (and unlocked for sending)
 * only when a real, SMTP-deliverable address is confirmed. Otherwise it stays
 * blocked (`needs_enrichment` / `invalid`).
 */
export async function enrichLead(leadId: number): Promise<EnrichResult | null> {
  const [existing] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  if (!existing) return null;

  logger.info({ leadId: existing.id }, "Starting enrichment pipeline");

  const [websiteRes, hiringRes] = await Promise.allSettled([
    analyzeWebsite(existing.website, existing.email ?? ""),
    detectHiringSignal(existing.website),
  ]);

  const website =
    websiteRes.status === "fulfilled"
      ? websiteRes.value
      : {
          reachable: false,
          summary: "",
          keywords: [] as string[],
          emailsFound: [] as string[],
          emailVisibleOnSite: false,
          noOptOutMention: true,
          fetchedUrl: null,
        };
  const hiring =
    hiringRes.status === "fulfilled"
      ? hiringRes.value
      : { isHiring: false, intentSignal: null };

  if (websiteRes.status === "rejected") {
    logger.warn(
      { err: websiteRes.reason, leadId: existing.id },
      "Website analysis failed",
    );
  }
  if (hiringRes.status === "rejected") {
    logger.warn(
      { err: hiringRes.reason, leadId: existing.id },
      "Hiring detection failed",
    );
  }

  // ─── Email resolution ───
  let finalEmail = existing.email;
  let emailValid = false;
  let emailValidationReason = "Aucun email à valider";
  let emailStatus: string | null = existing.emailStatus ?? "needs_enrichment";
  let emailLocked = existing.emailLocked;
  let emailVerified = false;
  let emailNote = "Aucun email vérifiable trouvé — le lead reste bloqué.";
  // An email published in plain view on the site satisfies the LCAP exemption.
  let emailVisibleOnSite = website.emailVisibleOnSite;

  if (shouldDiscoverEmail(existing)) {
    const discovered = await discoverVerifiedEmail(
      existing.website,
      existing.id,
    );
    if (discovered) {
      finalEmail = discovered.email;
      emailValid = true;
      emailValidationReason = "Vérifié par SMTP (RCPT TO)";
      emailStatus = "verified";
      emailLocked = false;
      emailVerified = true;
      emailVisibleOnSite = true;
      emailNote = discovered.note;
    } else if (existing.email) {
      // Couldn't source a better address — fall back to validating whatever we
      // already had, but only SMTP-deliverable addresses get promoted.
      const syntax = await validateEmail(existing.email);
      if (syntax.valid) {
        const smtp = await verifyEmailSmtp(existing.email);
        if (smtp.status === "deliverable") {
          emailValid = true;
          emailValidationReason = "Vérifié par SMTP (RCPT TO)";
          emailStatus = "verified";
          emailLocked = false;
          emailVerified = true;
          emailNote = "Email existant confirmé par SMTP.";
        } else {
          emailValidationReason = `Non vérifié par SMTP (${smtp.status})`;
          emailStatus = "needs_enrichment";
          emailNote = `Email existant non confirmé par SMTP (${smtp.reason}).`;
        }
      } else {
        emailValidationReason = syntax.reason;
        emailStatus = "invalid";
        emailNote = `Email existant invalide: ${syntax.reason}.`;
      }
    } else {
      emailStatus = "needs_enrichment";
    }
  } else if (existing.email) {
    // Already verified previously — re-affirm validity without re-probing.
    const syntax = await validateEmail(existing.email);
    emailValid = syntax.valid;
    emailValidationReason = syntax.reason;
    emailStatus = existing.emailStatus;
    emailVerified = existing.emailStatus === "verified";
    emailNote = "Email déjà vérifié précédemment.";
  }

  const lcap = assessLcap({
    emailVisibleOnSite,
    noOptOutMention: website.noOptOutMention,
    hasJobTitle: Boolean(existing.jobTitle && existing.jobTitle.trim()),
    emailValid,
  });

  const intentSignal =
    hiring.intentSignal ??
    (website.keywords.length > 0
      ? `Mots-clés du site: ${website.keywords.slice(0, 5).join(", ")}`
      : null);

  const [lead] = await db
    .update(leadsTable)
    .set({
      email: finalEmail ? finalEmail.toLowerCase() : existing.email,
      emailValid,
      emailValidationReason,
      emailStatus,
      emailLocked,
      isHiring: hiring.isHiring,
      intentSignal,
      websiteSummary: website.summary || null,
      websiteKeywords:
        website.keywords.length > 0 ? website.keywords.join(", ") : null,
      lcapCompliant: lcap.compliant,
      lcapReason: lcap.reason,
      stage: "enriched",
      unsubscribeToken:
        existing.unsubscribeToken ?? generateUnsubscribeToken(),
      updatedAt: new Date(),
    })
    .where(eq(leadsTable.id, existing.id))
    .returning();

  await db.insert(activitiesTable).values({
    type: "lead_enriched",
    description: `Enriched ${lead.firstName} ${lead.lastName} — ${
      lcap.compliant ? "LCAP OK" : "LCAP non conforme"
    }${emailVerified ? " · email vérifié" : ""}${
      hiring.isHiring ? " · hiring signal" : ""
    }`,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadId: lead.id,
  });

  return { lead, emailVerified, emailNote };
}
