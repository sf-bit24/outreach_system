/// <reference lib="dom" />
import type { BrowserContext } from "playwright";
import {
  newContextWithCredentials,
  jitterDelay,
  DRY_RUN,
  type StoredCredentials,
} from "./browser";

export interface ApolloSearchParams {
  keywords?: string;
  jobTitles?: string[];
  locations?: string[];
  perPage?: number;
  maxPages?: number;
}

export interface ScrapedApolloPerson {
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  company: string | null;
  email: string | null;
  emailLocked: boolean;
  linkedinUrl: string | null;
  location: string | null;
  sourceUrl: string;
}

const DEFAULT_PER_PAGE = 25;
const DEFAULT_MAX_PAGES = 1;

function buildSearchUrl(params: ApolloSearchParams): string {
  const url = new URL("https://app.apollo.io/#/people");
  const sp = url.searchParams;
  if (params.keywords) sp.set("qKeywords", params.keywords);
  for (const t of params.jobTitles ?? []) sp.append("personTitles[]", t);
  for (const l of params.locations ?? [])
    sp.append("personLocations[]", l);
  sp.set("page", "1");
  sp.set("sortByField", "recommendations_score");
  sp.set("sortAscending", "false");
  url.hash = `/people?${sp.toString()}`;
  return url.toString();
}

function dryRunResults(params: ApolloSearchParams): ScrapedApolloPerson[] {
  const seed = (params.keywords || "exemple").slice(0, 12);
  return Array.from({ length: 3 }).map((_, i) => ({
    firstName: `Demo${i + 1}`,
    lastName: seed,
    jobTitle: params.jobTitles?.[0] ?? "CEO",
    company: `${seed} Co ${i + 1}`,
    email: null,
    emailLocked: true,
    linkedinUrl: null,
    location: params.locations?.[0] ?? "Quebec, Canada",
    sourceUrl: buildSearchUrl(params),
  }));
}

/**
 * Scrape Apollo's in-app people search using authenticated session cookies.
 * IMPORTANT: emails marked `email_locked: true` are NEVER usable for sending.
 * They must be revealed/verified via Apollo credits or another verifier first.
 */
export async function scrapeApollo(
  creds: StoredCredentials,
  params: ApolloSearchParams,
): Promise<ScrapedApolloPerson[]> {
  if (DRY_RUN) return dryRunResults(params);

  const context = await newContextWithCredentials(creds);
  const results: ScrapedApolloPerson[] = [];
  const maxPages = Math.max(1, Math.min(params.maxPages ?? DEFAULT_MAX_PAGES, 5));
  const perPage = params.perPage ?? DEFAULT_PER_PAGE;

  try {
    const page = await context.newPage();
    const searchUrl = buildSearchUrl(params);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await jitterDelay(4000, 7000);

    // Detect login wall
    const loggedOut = await page
      .locator('input[name="email"], a[href*="/login"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (loggedOut) {
      throw new Error(
        "Apollo session expired or invalid. Re-import your apollo cookies.",
      );
    }

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // Wait for the search result rows to render
      await page
        .waitForSelector('[data-testid="person-row"], tr[class*="zp_"]', {
          timeout: 30000,
        })
        .catch(() => null);

      const rows = await page.$$('[data-testid="person-row"], tr[class*="zp_"]');
      for (const row of rows.slice(0, perPage)) {
        const data = await row
          .evaluate((el) => {
            const text = (sel: string) =>
              (el.querySelector(sel) as HTMLElement | null)?.innerText?.trim() ||
              null;
            const href = (sel: string) =>
              (el.querySelector(sel) as HTMLAnchorElement | null)?.href || null;
            const fullName =
              text('[data-testid="person-name"]') ||
              text('a[href*="/people/"]') ||
              "";
            const [first, ...rest] = fullName.split(/\s+/);
            const emailEl =
              el.querySelector('[data-testid="email"]') ||
              el.querySelector('a[href^="mailto:"]');
            const emailText = (emailEl as HTMLElement | null)?.innerText?.trim() ?? null;
            const locked =
              !emailText ||
              /access email|locked|reveal|••/i.test(emailText) ||
              emailText.includes("@") === false;
            return {
              firstName: first || "",
              lastName: rest.join(" "),
              jobTitle:
                text('[data-testid="title"]') || text('span[class*="title"]'),
              company:
                text('[data-testid="organization-name"]') ||
                text('a[href*="/organizations/"]'),
              email: locked ? null : emailText,
              emailLocked: locked,
              linkedinUrl: href('a[href*="linkedin.com/in/"]'),
              location: text('[data-testid="location"]'),
            };
          })
          .catch(() => null);

        if (!data || !data.firstName) continue;
        results.push({ ...data, sourceUrl: page.url() });
      }

      if (pageNum < maxPages) {
        const nextBtn = page.locator(
          'button[aria-label="Next page"], a[aria-label="Next"]',
        );
        const visible = await nextBtn.first().isVisible().catch(() => false);
        if (!visible) break;
        await nextBtn.first().click();
        await jitterDelay(8000, 14000);
      }
    }
  } finally {
    await context.close();
  }

  return results;
}
