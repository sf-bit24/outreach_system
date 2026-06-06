import * as cheerio from "cheerio";

export interface WebsiteAnalysis {
  reachable: boolean;
  summary: string;
  keywords: string[];
  emailsFound: string[];
  emailVisibleOnSite: boolean;
  noOptOutMention: boolean;
  fetchedUrl: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const UA =
  "Mozilla/5.0 (compatible; OutreachIQ/1.0; +https://outreachiq.local/bot)";

const STOPWORDS = new Set([
  "the","and","for","with","that","this","from","you","your","our","are",
  "have","has","but","not","all","can","will","into","more","new","one",
  "any","les","des","une","est","aux","pour","par","sur","dans","avec",
  "qui","que","nos","vos","ces","ses","son","sa","ils","elles","leur",
  "leurs","mais","tout","tous","toute","toutes","plus","comme","être",
  "avoir","faire","aussi","ainsi","entre","sans","ses","ces","cette","cet",
]);

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

function extractKeywords(text: string, limit = 10): string[] {
  const counts = new Map<string, number>();
  const words = text
    .toLowerCase()
    .replace(/[^a-zàâçéèêëîïôûùüÿñæœ\s-]/g, " ")
    .split(/\s+/);
  for (const w of words) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

/**
 * Replace common anti-scraping obfuscations so "info [at] acme (dot) com"
 * becomes "info@acme.com". Only the *bracketed* form is rewritten — requiring
 * surrounding brackets/parens avoids matching the letters "at"/"dot" inside
 * ordinary words (e.g. "static" must not become "st@ic"). Used on visible text
 * only; the result must still match a real email pattern to survive.
 */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[\[({]\s*(?:at|arobase|chez)\s*[\])}]\s*/gi, "@")
    .replace(/\s*[\[({]\s*(?:dot|point)\s*[\])}]\s*/gi, ".");
}

function extractEmails(text: string): string[] {
  const found = new Set<string>();
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const sources = [text, deobfuscate(text)];
  for (const src of sources) {
    for (const m of src.matchAll(re)) {
      const e = m[0].toLowerCase().replace(/\.$/, "");
      if (IMAGE_EXTS.some((ext) => e.endsWith(ext))) continue;
      // Skip addresses that are clearly asset/placeholder noise.
      if (/^[0-9a-f]{16,}@/.test(e)) continue;
      if (/(sentry|wixpress|example\.com|domain\.com|yourdomain)/.test(e)) {
        continue;
      }
      found.add(e);
    }
  }
  return [...found];
}

export async function analyzeWebsite(
  rawUrl: string | null | undefined,
  contactEmail?: string | null,
): Promise<WebsiteAnalysis> {
  const empty: WebsiteAnalysis = {
    reachable: false,
    summary: "",
    keywords: [],
    emailsFound: [],
    emailVisibleOnSite: false,
    noOptOutMention: true,
    fetchedUrl: null,
  };
  const url = normalizeUrl(rawUrl ?? "");
  if (!url) return empty;

  const res = await fetchWithTimeout(url);
  if (!res || !res.ok) return { ...empty, fetchedUrl: url };

  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();

  const title = $("title").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const h1 = $("h1").first().text().trim();
  const aboutText = $('section, div, p')
    .filter((_, el) => /about|à propos|notre mission|qui sommes/i.test($(el).text()))
    .first()
    .text()
    .trim()
    .slice(0, 500);

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const summary = [title, metaDesc, h1, aboutText]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 600);

  const keywords = extractKeywords(bodyText, 12);
  const emails = extractEmails(html);

  // LCAP visibility check: email present in mailto links or visible text on the page
  const mailtoEmails = $('a[href^="mailto:"]')
    .map((_, el) => $(el).attr("href")?.replace("mailto:", "").split("?")[0]?.toLowerCase())
    .get()
    .filter(Boolean) as string[];

  const visibleEmails = new Set([...emails, ...mailtoEmails]);
  const emailVisibleOnSite = contactEmail
    ? visibleEmails.has(contactEmail.toLowerCase())
    : visibleEmails.size > 0;

  // Check for opt-out / no-solicitation mentions
  const lowerBody = bodyText.toLowerCase();
  const optOutPhrases = [
    "no unsolicited",
    "no solicitation",
    "do not contact",
    "no spam",
    "pas de sollicitation",
    "pas de prospection",
    "ne pas contacter",
  ];
  const noOptOutMention = !optOutPhrases.some((p) => lowerBody.includes(p));

  return {
    reachable: true,
    summary,
    keywords,
    emailsFound: [...visibleEmails],
    emailVisibleOnSite,
    noOptOutMention,
    fetchedUrl: url,
  };
}

export interface ContactEmailCandidate {
  email: string;
  /** Page where the address was found (provenance for LCAP audit). */
  foundOn: string;
}

export interface ContactEmailResult {
  /** Ranked candidate emails — best (most likely a real, domain-matching
   *  mailbox) first. Every entry was published in plain view on the site. */
  candidates: ContactEmailCandidate[];
  /** Pages that were actually fetched while searching. */
  pagesChecked: string[];
}

const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/contactez-nous",
  "/contactus",
  "/nous-joindre",
  "/joindre",
  "/about",
  "/about-us",
  "/a-propos",
  "/à-propos",
  "/apropos",
  "/mentions-legales",
  "/mentions-légales",
  "/legal",
  "/legal-notice",
  "/privacy",
  "/politique-de-confidentialite",
  "/team",
  "/equipe",
  "/notre-equipe",
  "/support",
];

/** Role prefixes that are still valid LCAP-published contacts but are a less
 *  precise match than a personal/domain mailbox, so they rank lower. */
const GENERIC_PREFIXES = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "postmaster",
  "mailer-daemon",
  "abuse",
]);

function collectVisibleEmails(html: string): string[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  const bodyHtml = $("body").html() ?? html;
  const textEmails = extractEmails(bodyHtml);
  const mailtoEmails = $('a[href^="mailto:"]')
    .map((_, el) =>
      $(el).attr("href")?.replace(/^mailto:/i, "").split("?")[0]?.toLowerCase(),
    )
    .get()
    .filter(Boolean) as string[];
  return [...new Set([...mailtoEmails, ...textEmails])];
}

function rankCandidates(
  candidates: ContactEmailCandidate[],
  siteDomain: string | null,
): ContactEmailCandidate[] {
  const score = (email: string): number => {
    const [local, domain] = email.split("@");
    let s = 0;
    // Prefer addresses on the company's own domain (or a subdomain of it).
    if (
      siteDomain &&
      (domain === siteDomain || domain.endsWith(`.${siteDomain}`))
    ) {
      s += 100;
    }
    // Demote noreply/postmaster-style mailboxes — never useful for outreach.
    if (GENERIC_PREFIXES.has(local)) s -= 100;
    // Slightly prefer human-looking local parts (contain a dot or are short).
    if (/^[a-z]+\.[a-z]+$/.test(local)) s += 10;
    // Generic role inboxes (info@, contact@) are fine but rank below personal.
    if (/^(info|contact|hello|bonjour|sales|ventes)$/.test(local)) s += 5;
    return s;
  };
  return candidates
    .slice()
    .sort((a, b) => score(b.email) - score(a.email));
}

/**
 * Crawl a company website's homepage plus its contact / legal / about pages to
 * harvest email addresses that are "published in plain view" (LCAP-compliant).
 * Returns ranked candidates with provenance. Never invents an address — if the
 * site exposes none, the candidate list is empty.
 */
export async function findContactEmails(
  rawUrl: string | null | undefined,
): Promise<ContactEmailResult> {
  const url = normalizeUrl(rawUrl ?? "");
  if (!url) return { candidates: [], pagesChecked: [] };

  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return { candidates: [], pagesChecked: [] };
  }
  const siteDomain = base.hostname.replace(/^www\./, "").toLowerCase();

  const byEmail = new Map<string, ContactEmailCandidate>();
  const pagesChecked: string[] = [];

  const visitAndCollect = async (target: string): Promise<void> => {
    const res = await fetchWithTimeout(target);
    if (!res || !res.ok) return;
    const ctype = res.headers.get("content-type") ?? "";
    if (!/html|text/i.test(ctype)) return;
    const html = await res.text();
    pagesChecked.push(target);
    for (const email of collectVisibleEmails(html)) {
      if (!byEmail.has(email)) {
        byEmail.set(email, { email, foundOn: target });
      }
    }
  };

  // 1. Homepage first (footer often holds the contact address).
  await visitAndCollect(url);

  // 2. Discover linked contact/legal pages from the homepage anchors.
  const linkedPaths = new Set<string>();
  const homeRes = await fetchWithTimeout(url);
  if (homeRes && homeRes.ok) {
    const html = await homeRes.text();
    const $ = cheerio.load(html);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (/contact|joindre|mentions|legal|propos|about|confidential|privacy|equipe|team/i.test(href)) {
        try {
          const resolved = new URL(href, base);
          if (resolved.hostname.replace(/^www\./, "") === siteDomain) {
            linkedPaths.add(resolved.toString());
          }
        } catch {
          /* ignore malformed hrefs */
        }
      }
    });
  }

  // 3. Visit discovered links plus the conventional path guesses.
  const targets = new Set<string>([
    ...linkedPaths,
    ...CONTACT_PATHS.map((p) => new URL(p, base).toString()),
  ]);

  for (const target of targets) {
    // Stop early once we have a few strong candidates to limit requests.
    if (byEmail.size >= 8) break;
    await visitAndCollect(target);
  }

  return {
    candidates: rankCandidates([...byEmail.values()], siteDomain),
    pagesChecked,
  };
}

export async function detectHiringSignal(
  rawUrl: string | null | undefined,
): Promise<{ isHiring: boolean; intentSignal: string | null }> {
  const url = normalizeUrl(rawUrl ?? "");
  if (!url) return { isHiring: false, intentSignal: null };

  const base = new URL(url);
  const candidatePaths = [
    "/careers",
    "/jobs",
    "/carrieres",
    "/carrières",
    "/emplois",
    "/we-are-hiring",
    "/join-us",
    "/recrutement",
  ];

  for (const path of candidatePaths) {
    const target = new URL(path, base).toString();
    const res = await fetchWithTimeout(target);
    if (!res || !res.ok) continue;
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style").remove();
    const text = $("body").text().toLowerCase();
    const hiringIndicators = [
      "open positions",
      "we're hiring",
      "now hiring",
      "join our team",
      "current openings",
      "nous recrutons",
      "nous embauchons",
      "postes ouverts",
      "rejoindre l'équipe",
    ];
    const matched = hiringIndicators.find((kw) => text.includes(kw));
    if (matched) {
      // Try to extract job titles from links / headings
      const titles = $("h2, h3, a")
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(
          (t) =>
            t.length > 0 &&
            t.length < 80 &&
            /(manager|director|engineer|sales|marketing|developer|analyst|lead|head of|vp |chief)/i.test(
              t,
            ),
        )
        .slice(0, 3);
      const titleHint = titles.length > 0 ? ` (e.g. ${titles.join(", ")})` : "";
      return {
        isHiring: true,
        intentSignal: `Currently hiring${titleHint}`,
      };
    }
  }

  // Check homepage for hiring banners
  const homeRes = await fetchWithTimeout(url);
  if (homeRes && homeRes.ok) {
    const html = (await homeRes.text()).toLowerCase();
    if (/we[' ]re hiring|nous recrutons|join our team|rejoignez-nous/i.test(html)) {
      return { isHiring: true, intentSignal: "Hiring banner on homepage" };
    }
  }

  return { isHiring: false, intentSignal: null };
}
