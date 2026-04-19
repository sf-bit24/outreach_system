import { chromium, type Browser, type BrowserContext, type Cookie } from "playwright";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Resolve the Chromium binary at runtime instead of hardcoding a Nix store
 * path with a hash (which becomes invalid every time the package is updated).
 * Order: explicit env override → `which chromium` → first existing well-known
 * path → undefined (let Playwright fall back to its bundled binary if any).
 */
function resolveChromiumPath(): string | undefined {
  const env =
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (env && existsSync(env)) return env;

  try {
    const found = execSync("command -v chromium || command -v chromium-browser || command -v google-chrome", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* ignore */
  }

  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

const CHROMIUM_PATH = resolveChromiumPath();

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
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
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
