import { openai } from "@workspace/integrations-openai-ai-server";
import type { Lead, SenderSettings } from "@workspace/db";

const MODEL = "gpt-5.2";

export interface PersonalizedEmail {
  subject: string;
  hook: string;
  body: string;
}

/**
 * Sanitize untrusted scraped/free-form input before injecting into LLM prompts.
 * Defends against prompt injection attempts coming from website content.
 */
function sanitizeUntrusted(input: string | null | undefined, max = 400): string {
  if (!input) return "";
  return input
    .replace(/[\r\n]+/g, " ")
    .replace(/```/g, "  ")
    .replace(/(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)/gi, "[filtered]")
    .replace(/system\s*[:>]/gi, "[filtered]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function buildLeadContext(lead: Lead): string {
  const parts = [
    `Contact: ${sanitizeUntrusted(lead.firstName, 80)} ${sanitizeUntrusted(lead.lastName, 80)}`,
    `Title: ${sanitizeUntrusted(lead.jobTitle, 120)}`,
    `Company: ${sanitizeUntrusted(lead.company, 120)}`,
    lead.industry && `Industry: ${sanitizeUntrusted(lead.industry, 80)}`,
    lead.companySize && `Company size: ${sanitizeUntrusted(lead.companySize, 40)}`,
    lead.location && `Location: ${sanitizeUntrusted(lead.location, 80)}`,
    lead.website && `Website: ${sanitizeUntrusted(lead.website, 200)}`,
    lead.websiteSummary && `Website summary: ${sanitizeUntrusted(lead.websiteSummary, 400)}`,
    lead.websiteKeywords && `Website keywords: ${sanitizeUntrusted(lead.websiteKeywords, 300)}`,
    lead.intentSignal && `Intent signal: ${sanitizeUntrusted(lead.intentSignal, 200)}`,
    lead.isHiring && "Currently hiring (growth phase)",
    lead.painPoint && `Likely pain point: ${sanitizeUntrusted(lead.painPoint, 200)}`,
  ].filter(Boolean);
  return parts.join("\n");
}

async function chat(prompt: string, system?: string): Promise<string> {
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 8192,
    messages,
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Stage 1 — semantic analysis: identify pain point + opportunity
 * (only runs if lead doesn't already have a pain point set)
 */
export async function analyzePainPoint(lead: Lead): Promise<string> {
  const ctx = buildLeadContext(lead);
  const prompt = `Tu es un analyste B2B. À partir des informations suivantes sur un prospect, identifie en UNE phrase courte (max 25 mots) le point de douleur le plus probable que cette personne rencontre dans son rôle. Réponds uniquement avec la phrase, sans préambule.

${ctx}

Point de douleur:`;
  return chat(prompt);
}

/**
 * Stage 2 — generate a unique hook based on a real fact about the prospect.
 */
export async function generateHook(lead: Lead): Promise<string> {
  const ctx = buildLeadContext(lead);
  const prompt = `Tu rédiges l'accroche d'un email de prospection B2B en français.
Règles:
- Max 25 mots, une seule phrase.
- Tutoiement interdit, vouvoiement obligatoire.
- Doit faire référence à un fait spécifique sur l'entreprise ou le contact (signal d'intention, mot-clé du site, secteur, recrutement, etc.).
- Pas de flatterie générique du type "j'admire votre travail".
- Pas de point d'exclamation.
Réponds uniquement avec l'accroche, sans guillemets ni préambule.

Prospect:
${ctx}

Accroche:`;
  return chat(prompt);
}

/**
 * Stage 3 — full email generation, integrating hook + POC strategy + CTA.
 */
export async function generateEmailBody(
  lead: Lead,
  hook: string,
  settings: SenderSettings,
): Promise<{ subject: string; body: string }> {
  const ctx = buildLeadContext(lead);
  const valueProp =
    settings.valueProposition ||
    "automatiser la prospection B2B sortante de manière conforme et personnalisée";

  const system = `Tu es un copywriter B2B francophone spécialisé en emails de prospection à froid. Ton ton est professionnel, direct et respectueux. Tu écris pour des décideurs occupés.`;

  const prompt = `Rédige un email de prospection B2B en français pour ${lead.firstName} ${lead.lastName} (${lead.jobTitle}) chez ${lead.company}.

Contexte du prospect:
${ctx}

Contraintes:
- Commence par "Bonjour ${lead.firstName},"
- Utilise CETTE accroche EXACTE comme première phrase après la salutation: "${hook}"
- Corps de 90 à 130 mots maximum, paragraphes courts (2-3 lignes max).
- Mentionne brièvement notre proposition de valeur: ${valueProp}.
- Intègre cette preuve par l'exemple de manière fluide en avant-dernier paragraphe: "${settings.pocMessage}"
- Termine par un appel à l'action clair: proposer un échange de 15 minutes la semaine prochaine.
- Signe avec: "${settings.senderName}".
- Ne mets PAS d'objet, PAS de signature avec coordonnées (elles seront ajoutées automatiquement), PAS de lien de désabonnement.
- Pas de listes à puces, pas de gras, texte brut uniquement.

Répond strictement au format suivant:
SUJET: <ligne d'objet 6-9 mots, sans point final>
---
<corps de l'email>`;

  const raw = await chat(prompt, system);

  const subjectMatch = raw.match(/SUJET\s*:\s*(.+)/i);
  const subject =
    subjectMatch?.[1]?.trim().slice(0, 120) ||
    `Question rapide pour ${lead.firstName} — ${lead.company}`;

  let body = raw;
  const sepIdx = raw.indexOf("---");
  if (sepIdx >= 0) body = raw.slice(sepIdx + 3).trim();
  else if (subjectMatch) body = raw.replace(subjectMatch[0], "").trim();

  return { subject, body };
}

/**
 * Full personalization pipeline: analyze → hook → body.
 */
export async function personalizeEmail(
  lead: Lead,
  settings: SenderSettings,
): Promise<PersonalizedEmail> {
  const hook = await generateHook(lead);
  const { subject, body } = await generateEmailBody(lead, hook, settings);
  return { subject, hook, body };
}
