/// <reference lib="dom" />
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { jitterDelay, DRY_RUN } from "./browser";

export interface GmapsSearchParams {
  category?: string;
  city?: string;
  radiusKm?: number;
  maxResults?: number;
}

export interface ScrapedGmapsPlace {
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  rating: number | null;
  reviewsCount: number | null;
  sourceUrl: string;
}

const DEFAULT_MAX_RESULTS = 25;
const HARD_CAP = 80;

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function resolveChromiumPath(): string | undefined {
  const env =
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (env && existsSync(env)) return env;
  try {
    const found = execSync(
      "command -v chromium || command -v chromium-browser || command -v google-chrome",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* ignore */
  }
  for (const p of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function buildSearchQuery(params: GmapsSearchParams): string {
  const parts: string[] = [];
  if (params.category) parts.push(params.category.trim());
  if (params.city) parts.push(params.city.trim());
  // Append the radius as a textual hint so Google Maps biases results to a
  // tighter geographic area. Google parses "within Xkm" / "Xkm" tokens in
  // the search box, which constrains the viewport accordingly.
  if (params.radiusKm && params.radiusKm > 0) {
    parts.push(`${params.radiusKm} km`);
  }
  return parts.join(" ").trim() || "restaurants";
}

/**
 * Map a radius in km to a Google Maps zoom level. Smaller radius = closer
 * zoom. Used as a `?z=` hint when the URL allows it.
 */
function radiusToZoom(radiusKm: number): number {
  const z = Math.round(14 - Math.log2(Math.max(1, radiusKm)));
  return Math.min(17, Math.max(8, z));
}

function buildSearchUrl(params: GmapsSearchParams): string {
  const q = encodeURIComponent(buildSearchQuery(params));
  const zoom = params.radiusKm && params.radiusKm > 0
    ? `&z=${radiusToZoom(params.radiusKm)}`
    : "";
  return `https://www.google.com/maps/search/${q}/?hl=fr&gl=ca${zoom}`;
}

function dryRunResults(params: GmapsSearchParams): ScrapedGmapsPlace[] {
  const seed = (params.category || "exemple").slice(0, 20);
  const city = params.city || "Montréal";
  const max = Math.min(params.maxResults ?? 5, 5);
  return Array.from({ length: max }).map((_, i) => ({
    name: `${seed} Démo ${i + 1}`,
    address: `${100 + i} rue Démo, ${city}, QC`,
    phone: `+1 514-555-01${(i + 10).toString().padStart(2, "0")}`,
    website: `https://exemple-${i + 1}-${seed.toLowerCase().replace(/\s+/g, "-")}.ca`,
    category: params.category ?? null,
    rating: 4 + (i % 5) / 10,
    reviewsCount: 10 + i * 3,
    sourceUrl: buildSearchUrl(params),
  }));
}

/**
 * Scrape Google Maps search results (public listings; no login required).
 * Extracts business name, address, phone, website. Email is NEVER returned —
 * downstream enrichment finds the email from the website. Conservative
 * delays + per-process serialization keep us off Google's throttling radar.
 */
export async function scrapeGmaps(
  params: GmapsSearchParams,
): Promise<ScrapedGmapsPlace[]> {
  if (DRY_RUN) return dryRunResults(params);

  const maxResults = Math.max(
    1,
    Math.min(params.maxResults ?? DEFAULT_MAX_RESULTS, HARD_CAP),
  );
  const chromiumPath = resolveChromiumPath();
  const browser = await chromium.launch({
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1366, height: 900 },
    locale: "fr-CA",
    timezoneId: "America/Montreal",
  });

  const results: ScrapedGmapsPlace[] = [];

  try {
    const page = await context.newPage();
    const searchUrl = buildSearchUrl(params);
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await jitterDelay(4000, 8000);

    // Accept consent if Google shows the EU-style consent wall.
    const consentBtn = page
      .locator(
        'button:has-text("Tout accepter"), button:has-text("Accept all"), button[aria-label*="Accept"]',
      )
      .first();
    if (await consentBtn.isVisible().catch(() => false)) {
      await consentBtn.click().catch(() => undefined);
      await jitterDelay(2000, 4000);
    }

    // Wait for the results feed to appear.
    const feedSel = 'div[role="feed"]';
    await page.waitForSelector(feedSel, { timeout: 30000 }).catch(() => null);

    // Scroll the feed until we have enough cards or hit the end-of-list marker.
    let lastCount = 0;
    let stableLoops = 0;
    for (let i = 0; i < 25; i++) {
      const count = await page.$$eval('a.hfpxzc', (els) => els.length).catch(() => 0);
      if (count >= maxResults * 1.4) break;
      if (count === lastCount) {
        stableLoops++;
        if (stableLoops >= 3) break;
      } else {
        stableLoops = 0;
      }
      lastCount = count;
      await page
        .$eval(feedSel, (el) => {
          (el as HTMLElement).scrollBy(0, 1200);
        })
        .catch(() => undefined);
      await jitterDelay(1500, 3000);
    }

    const cardLinks = await page.$$('a.hfpxzc');
    const seenUrls = new Set<string>();

    for (const link of cardLinks) {
      if (results.length >= maxResults) break;

      const placeUrl = await link.getAttribute("href").catch(() => null);
      if (!placeUrl || seenUrls.has(placeUrl)) continue;
      seenUrls.add(placeUrl);

      // Click the card to open the detail panel; extract from the side panel.
      try {
        await link.click({ delay: 50 }).catch(() => undefined);
      } catch {
        continue;
      }

      // Wait for the detail panel to load (heading + buttons).
      await page
        .waitForSelector('h1.DUwDvf, h1[class*="DUwDvf"]', { timeout: 12000 })
        .catch(() => null);
      await jitterDelay(1500, 3000);

      const data = await page
        .evaluate(() => {
          const text = (sel: string) =>
            (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim() || null;

          const name = text('h1.DUwDvf') || text('h1[class*="DUwDvf"]');

          // Buttons in the detail panel are identified by their data-item-id
          // attribute: "address", "phone:tel:...", "authority" (= website).
          const grab = (selector: string): string | null => {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (!el) return null;
            return (
              el.getAttribute("aria-label")?.replace(/^[^:]+:\s*/, "")?.trim() ||
              el.innerText?.trim() ||
              null
            );
          };
          const address = grab('button[data-item-id="address"]');
          const phoneRaw = grab('button[data-item-id^="phone:tel:"]');
          const phone = phoneRaw?.replace(/^Téléphone:\s*/i, "")?.trim() ?? null;

          const websiteEl = document.querySelector(
            'a[data-item-id="authority"]',
          ) as HTMLAnchorElement | null;
          const website = websiteEl?.href || null;

          // Category sits right under the name.
          const category =
            (document.querySelector('button[jsaction*="category"]') as HTMLElement | null)
              ?.innerText?.trim() || null;

          // Rating + reviews are exposed in the header area.
          const ratingText = (
            document.querySelector('div.F7nice span[aria-hidden="true"]') as HTMLElement | null
          )?.innerText?.trim();
          const reviewsText = (
            document.querySelector('div.F7nice span[aria-label*="avis"], div.F7nice span[aria-label*="reviews"]') as HTMLElement | null
          )?.getAttribute("aria-label");

          const rating = ratingText ? parseFloat(ratingText.replace(",", ".")) : null;
          const reviewsCount = reviewsText
            ? parseInt(reviewsText.replace(/[^\d]/g, ""), 10) || null
            : null;

          return { name, address, phone, website, category, rating, reviewsCount };
        })
        .catch(() => null);

      if (!data || !data.name) continue;

      results.push({
        name: data.name,
        address: data.address,
        phone: data.phone,
        website: data.website,
        category: data.category,
        rating: typeof data.rating === "number" && Number.isFinite(data.rating)
          ? data.rating
          : null,
        reviewsCount: data.reviewsCount ?? null,
        sourceUrl: page.url(),
      });

      // Random per-detail delay to mimic a human browsing.
      await jitterDelay(2500, 5000);
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  return results;
}
