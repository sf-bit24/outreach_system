import { randomBytes } from "node:crypto";

/**
 * LCAP (Loi C-28) compliance helpers.
 * The Canadian anti-spam law requires either explicit/tacit consent or
 * a "publication bien en vue" exemption: the email must be published
 * conspicuously without a no-solicitation notice, and the message must
 * relate to the recipient's professional functions.
 */

export interface LcapAssessment {
  compliant: boolean;
  reason: string;
}

export function assessLcap(args: {
  emailVisibleOnSite: boolean;
  noOptOutMention: boolean;
  hasJobTitle: boolean;
  emailValid: boolean;
}): LcapAssessment {
  if (!args.emailValid) {
    return { compliant: false, reason: "Email invalide ou non délivrable" };
  }
  if (!args.hasJobTitle) {
    return {
      compliant: false,
      reason: "Pas de fonction professionnelle identifiée",
    };
  }
  if (!args.emailVisibleOnSite) {
    return {
      compliant: false,
      reason: "Email non publié de manière visible sur le site (exemption LCAP non applicable)",
    };
  }
  if (!args.noOptOutMention) {
    return {
      compliant: false,
      reason: "Le site mentionne un refus de sollicitation",
    };
  }
  return {
    compliant: true,
    reason: "Email publié bien en vue, sans mention d'exclusion, lié aux fonctions",
  };
}

export function generateUnsubscribeToken(): string {
  return randomBytes(16).toString("hex");
}
