import { chromium, type Browser, type BrowserContext, type Cookie } from "playwright";

const CHROMIUM_PATH =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export interface StoredCredentials {
  cookies: Cookie[];
  userAgent?: string;
  label?: string;
}

let cached: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (cached && cached.isConnected()) return cached;
  cached = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  return cached;
}

export async function closeBrowser(): Promise<void> {
  if (cached) {
    try {
      await cached.close();
    } catch {
      /* ignore */
    }
    cached = null;
  }
}

export async function newContextWithCredentials(
  creds: StoredCredentials,
): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: creds.userAgent || DEFAULT_UA,
    viewport: { width: 1366, height: 768 },
    locale: "fr-CA",
    timezoneId: "America/Montreal",
  });
  if (creds.cookies?.length) {
    await context.addCookies(creds.cookies);
  }
  return context;
}

export function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, ms));
}

export const DRY_RUN = process.env.SCRAPING_DRY_RUN === "1";
