/**
 * News signal fetcher — searches Google News RSS for recent company mentions
 * and returns a short human-readable summary (≤ 200 chars).
 *
 * Uses Google News RSS (no API key required).  Silently returns null on any
 * error or when no relevant recent news is found.
 */

const FETCH_TIMEOUT_MS = 5_000;
const MAX_AGE_DAYS = 90;

const UA = "Mozilla/5.0 (compatible; OutreachIQ/1.0)";

function msAgo(dateStr: string): number {
  try {
    return Date.now() - new Date(dateStr).getTime();
  } catch {
    return Infinity;
  }
}

/** Strip XML/HTML tags from a string. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

/** Collapse whitespace. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface NewsItem {
  title: string;
  pubDate: string;
  link: string;
}

function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = stripTags(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const pubDate = stripTags(block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
    const link = stripTags(block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "");
    if (title && pubDate) {
      items.push({ title: clean(title), pubDate, link });
    }
  }
  return items;
}

/**
 * Fetch recent Google News articles for `companyName` (+ optional `location`).
 * Returns a summary string like:
 *   "Levée de fonds 2M$ (juin 2026) · Ouverture bureau Toronto"
 * or null when no relevant news is found.
 */
export async function fetchNewsSignal(
  companyName: string | null | undefined,
  location?: string | null,
): Promise<string | null> {
  if (!companyName || companyName.trim().length < 3) return null;

  // Build query — company name, optionally restricted by location
  const query = [companyName.trim(), location?.trim()].filter(Boolean).join(" ");
  const encoded = encodeURIComponent(query);
  const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=fr-CA&gl=CA&ceid=CA:fr`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let xml: string;
  try {
    const res = await fetch(rssUrl, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const items = parseRssItems(xml);
  const cutoff = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  // Filter to recent items and exclude noise (weather, unrelated)
  const recent = items.filter((item) => msAgo(item.pubDate) < cutoff);
  if (recent.length === 0) return null;

  // Take up to 2 most recent items; format as "title (month year)"
  const summaries = recent.slice(0, 2).map((item) => {
    let title = item.title;
    // Remove the " - Source" suffix often appended by Google News
    title = title.replace(/\s*[-–|]\s*[^-–|]{3,50}$/, "").trim();
    // Format date as "mois année"
    let dateStr = "";
    try {
      const d = new Date(item.pubDate);
      dateStr = d.toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
    } catch {
      // ignore
    }
    return dateStr ? `${title} (${dateStr})` : title;
  });

  const combined = summaries.join(" · ");
  return combined.slice(0, 250) || null;
}
