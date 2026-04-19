/// <reference lib="dom" />
import {
  newContextWithCredentials,
  jitterDelay,
  DRY_RUN,
  type StoredCredentials,
} from "./browser";

export interface LinkedInSearchParams {
  keywords?: string;
  jobTitles?: string[];
  locations?: string[];
  maxResults?: number;
}

export interface ScrapedLinkedInPerson {
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  company: string | null;
  linkedinUrl: string;
  location: string | null;
  sourceUrl: string;
}

function buildSearchUrl(params: LinkedInSearchParams): string {
  const sp = new URLSearchParams();
  const kw = [
    params.keywords ?? "",
    ...(params.jobTitles ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  if (kw) sp.set("keywords", kw);
  if (params.locations?.length) {
    sp.set("origin", "FACETED_SEARCH");
    sp.set("geoUrn", params.locations.join(","));
  }
  return `https://www.linkedin.com/search/results/people/?${sp.toString()}`;
}

function dryRunResults(params: LinkedInSearchParams): ScrapedLinkedInPerson[] {
  const seed = (params.keywords || "exemple").slice(0, 12);
  return Array.from({ length: 3 }).map((_, i) => ({
    firstName: `Demo${i + 1}`,
    lastName: seed,
    jobTitle: params.jobTitles?.[0] ?? "CEO",
    company: `${seed} Co ${i + 1}`,
    linkedinUrl: `https://www.linkedin.com/in/demo-${i + 1}-${seed.toLowerCase()}`,
    location: params.locations?.[0] ?? "Quebec, Canada",
    sourceUrl: buildSearchUrl(params),
  }));
}

/**
 * Scrape LinkedIn People search using a logged-in session cookie (li_at).
 * IMPORTANT: LinkedIn does NOT expose emails in search results. Every lead
 * is created with `email: null`, `email_status: "needs_enrichment"` so that
 * downstream sending is blocked until a real email is sourced and verified.
 */
export async function scrapeLinkedIn(
  creds: StoredCredentials,
  params: LinkedInSearchParams,
): Promise<ScrapedLinkedInPerson[]> {
  if (DRY_RUN) return dryRunResults(params);

  const context = await newContextWithCredentials(creds);
  const results: ScrapedLinkedInPerson[] = [];
  const maxResults = Math.max(1, Math.min(params.maxResults ?? 25, 100));

  try {
    const page = await context.newPage();
    const searchUrl = buildSearchUrl(params);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await jitterDelay(8000, 15000);

    const loggedOut = page.url().includes("/login") || page.url().includes("/checkpoint");
    if (loggedOut) {
      throw new Error(
        "LinkedIn session expired or invalid. Re-import your li_at cookie.",
      );
    }

    let pageNum = 1;
    while (results.length < maxResults && pageNum <= 5) {
      await page
        .waitForSelector('li.reusable-search__result-container, div.reusable-search__result-container', {
          timeout: 20000,
        })
        .catch(() => null);

      // Scroll down to trigger lazy load
      await page.evaluate(() => window.scrollBy(0, 1500));
      await jitterDelay(8000, 12000);

      const rows = await page.$$('li.reusable-search__result-container, div.reusable-search__result-container');
      for (const row of rows) {
        if (results.length >= maxResults) break;
        const data = await row
          .evaluate((el) => {
            const text = (sel: string) =>
              (el.querySelector(sel) as HTMLElement | null)?.innerText?.trim() ||
              null;
            const href = (sel: string) =>
              (el.querySelector(sel) as HTMLAnchorElement | null)?.href || null;
            const profileLink =
              href('a[href*="/in/"]') || "";
            const fullName =
              text('span[aria-hidden="true"]') ||
              text('.entity-result__title-text a') ||
              "";
            const [first, ...rest] = fullName.split(/\s+/);
            const subtitle = text('.entity-result__primary-subtitle') || "";
            // Common format: "Job Title at Company"
            const atMatch = subtitle.match(/^(.+?)\s+(?:at|chez|@)\s+(.+)$/i);
            return {
              firstName: first || "",
              lastName: rest.join(" "),
              jobTitle: atMatch?.[1] ?? subtitle ?? null,
              company: atMatch?.[2] ?? null,
              linkedinUrl: profileLink.split("?")[0] || "",
              location: text('.entity-result__secondary-subtitle'),
            };
          })
          .catch(() => null);

        if (!data || !data.firstName || !data.linkedinUrl) continue;
        // Per-lead provenance: store the actual profile URL so an auditor can
        // trace each scraped row back to its origin.
        results.push({
          ...data,
          linkedinUrl: data.linkedinUrl,
          sourceUrl: data.linkedinUrl,
        });
      }

      // Pagination
      const nextBtn = page.locator('button[aria-label="Next"]');
      const visible = await nextBtn.first().isVisible().catch(() => false);
      if (!visible || results.length >= maxResults) break;
      await nextBtn.first().click();
      await jitterDelay(12000, 22000);
      pageNum++;
    }
  } finally {
    await context.close();
  }

  return results.slice(0, maxResults);
}
