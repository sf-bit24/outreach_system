/**
 * Hiring extractor — scrapes company career pages to extract actual job title
 * strings rather than just a hiring boolean.
 *
 * Returns a pipe-separated string of up to 5 roles, e.g.:
 *   "Directeur Commercial · Chargé de compte · Développeur React"
 * or null when no relevant pages or roles are found.
 */

import * as cheerio from "cheerio";

const FETCH_TIMEOUT_MS = 6_000;
const UA = "Mozilla/5.0 (compatible; OutreachIQ/1.0)";

const CAREER_PATHS = [
  "/careers",
  "/jobs",
  "/carrieres",
  "/carrières",
  "/emplois",
  "/we-are-hiring",
  "/join-us",
  "/recrutement",
  "/postes",
  "/join",
  "/offres-emploi",
  "/offres",
  "/work-with-us",
  "/travailler-avec-nous",
];

/** Job-title keywords that signal a genuine posting title rather than nav text. */
const TITLE_KEYWORDS =
  /\b(manager|directeur|director|engineer|ingénieur|sales|ventes|marketing|developer|développeur|analyst|analyste|lead|chef|head of|responsable|coordinat|chargé|vp |chief|consultant|specialist|spécialiste|représentant|account|advisor|conseiller|assistant|associate|senior|junior|stagiaire|intern|technicien|technician)\b/i;

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

/**
 * Extract actual job role titles from a page's text nodes.
 * Focuses on short, meaningful strings that look like job titles.
 */
function extractRolesFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, header").remove();

  const candidates = new Set<string>();

  // Job listing containers — check headings and list items
  $("h1, h2, h3, h4, li, a").each((_, el) => {
    const text = $(el).text().trim();
    if (
      text.length >= 5 &&
      text.length <= 90 &&
      TITLE_KEYWORDS.test(text) &&
      // Exclude navigation-style items (too many words or pure uppercase nav links)
      text.split(/\s+/).length <= 8
    ) {
      // Normalize and deduplicate
      const normalized = text.replace(/\s+/g, " ").trim();
      candidates.add(normalized);
    }
  });

  return [...candidates].slice(0, 5);
}

/**
 * Attempt to scrape career pages for a company website and return a
 * pipe-separated string of role titles, or null if nothing is found.
 */
export async function extractHiringRoles(
  rawUrl: string | null | undefined,
): Promise<{ hiringRoles: string | null; isHiring: boolean }> {
  const url = normalizeUrl(rawUrl ?? "");
  if (!url) return { hiringRoles: null, isHiring: false };

  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return { hiringRoles: null, isHiring: false };
  }

  const allRoles: string[] = [];

  for (const path of CAREER_PATHS) {
    if (allRoles.length >= 5) break;

    const target = new URL(path, base).toString();
    const res = await fetchWithTimeout(target);
    if (!res || !res.ok) continue;

    const html = await res.text();

    // Quick check: does this page look like it has job postings?
    const lowerHtml = html.toLowerCase();
    const hiringIndicators = [
      "open position", "we're hiring", "now hiring", "join our team",
      "current opening", "nous recrutons", "nous embauchons", "postes ouverts",
      "rejoindre l'équipe", "offre d'emploi", "poste à pourvoir",
      "apply now", "postuler", "submit your application",
    ];
    const isCareerPage = hiringIndicators.some((kw) =>
      lowerHtml.includes(kw),
    );
    if (!isCareerPage) continue;

    const roles = extractRolesFromHtml(html);
    for (const role of roles) {
      if (allRoles.length < 5 && !allRoles.includes(role)) {
        allRoles.push(role);
      }
    }
  }

  if (allRoles.length === 0) return { hiringRoles: null, isHiring: false };

  return {
    hiringRoles: allRoles.join(" · "),
    isHiring: true,
  };
}
