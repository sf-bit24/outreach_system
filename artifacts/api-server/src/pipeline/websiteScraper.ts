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

function extractEmails(text: string): string[] {
  const found = new Set<string>();
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  for (const m of text.matchAll(re)) {
    const e = m[0].toLowerCase();
    if (!e.endsWith(".png") && !e.endsWith(".jpg")) {
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
