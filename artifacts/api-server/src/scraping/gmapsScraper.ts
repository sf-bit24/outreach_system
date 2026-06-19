import { spawn } from "node:child_process";
import { writeFile, readFile, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { logger } from "../lib/logger";
import { DRY_RUN } from "./browser";

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
  email: string | null;
}

export const GMAPS_BINARY = "/tmp/gmaps-scraper";
const BINARY_VERSION = "1.12.1";
const BINARY_URL = `https://github.com/gosom/google-maps-scraper/releases/download/v${BINARY_VERSION}/google_maps_scraper-${BINARY_VERSION}-linux-amd64`;
const VERSION_FILE = `${GMAPS_BINARY}.version`;

const DEFAULT_MAX_RESULTS = 25;
const HARD_CAP = 100;

// Playwright-go 1.57.0 (used by gosom 1.12.1) downloads Chrome headless shell
// revision 1200 into PLAYWRIGHT_BROWSERS_PATH.  On NixOS/Replit the downloaded
// binary fails to load libglib-2.0.so.0. We replace it with a thin sh wrapper
// that delegates to the system Nix Chromium (which already has its LD paths
// baked in via the Nix wrapper script).
const PLAYWRIGHT_BROWSERS_PATH = "/tmp/pw-browsers";
const CHROME_REVISION = "1200";
const CHROME_WRAPPER_PATH = `${PLAYWRIGHT_BROWSERS_PATH}/chromium_headless_shell-${CHROME_REVISION}/chrome-headless-shell-linux64/chrome-headless-shell`;

function resolveChromiumPath(): string | undefined {
  const env =
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (env && existsSync(env)) return env;
  try {
    const found = execSync(
      "command -v chromium || command -v chromium-browser || command -v google-chrome",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
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
  // NixOS: the Chromium nix-store wrapper sets LD paths internally, so even
  // though the downloaded headless shell fails, the nix binary works fine.
  try {
    const found = execSync(
      "ls /nix/store/*/bin/chromium 2>/dev/null | head -1",
      { encoding: "utf8", shell: "/bin/sh", timeout: 5000 },
    ).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * On NixOS the playwright-go chrome-headless-shell download fails to load
 * libglib-2.0.so.0 (NixOS libraries live under /nix/store, not /lib).
 * This function replaces the broken ELF binary at CHROME_WRAPPER_PATH with a
 * POSIX sh wrapper that exec's the system Nix Chromium, which already has its
 * library search paths baked into the Nix wrapper script.
 *
 * Called both:
 *  a) after ensureGmapsBinary() so subsequent runs are pre-fixed, and
 *  b) inside scrapeGmaps() on a shared-library error before retrying.
 *
 * Returns true if the wrapper was successfully created.
 */
async function setupChromiumWrapper(): Promise<boolean> {
  if (!existsSync(CHROME_WRAPPER_PATH)) {
    // Chrome hasn't been downloaded yet — nothing to fix.
    return false;
  }

  const chromiumPath = resolveChromiumPath();
  if (!chromiumPath) {
    logger.warn("No system Chromium found — cannot create NixOS wrapper");
    return false;
  }

  // If the file is already a shell script we wrote, nothing to do.
  try {
    const content = await readFile(CHROME_WRAPPER_PATH, "utf8");
    if (content.startsWith("#!/")) {
      logger.info(
        { wrapperPath: CHROME_WRAPPER_PATH },
        "Nix Chromium wrapper already in place",
      );
      return true;
    }
  } catch {
    // binary file, not readable as text — proceed to overwrite
  }

  const wrapperScript = `#!/bin/sh\nexec "${chromiumPath}" "$@"\n`;
  await writeFile(CHROME_WRAPPER_PATH, wrapperScript);
  await chmod(CHROME_WRAPPER_PATH, 0o755);
  logger.info(
    { chromiumPath, wrapperPath: CHROME_WRAPPER_PATH },
    "Replaced chrome-headless-shell with Nix Chromium wrapper",
  );
  return true;
}

/**
 * Download the gosom Google Maps scraper binary if not already present.
 * Also pre-installs the Nix Chromium wrapper if Chrome was already downloaded
 * by a previous run (so the next job doesn't need a retry).
 * Fire-and-forget safe — logs errors but never throws.
 */
export async function ensureGmapsBinary(): Promise<boolean> {
  if (DRY_RUN) return true;

  if (existsSync(GMAPS_BINARY) && existsSync(VERSION_FILE)) {
    const stored = await readFile(VERSION_FILE, "utf8").catch(() => "");
    if (stored.trim() === BINARY_VERSION) {
      logger.info({ version: BINARY_VERSION }, "gosom binary already present");
      // Best-effort: fix Chrome wrapper if leftover from a previous failed run
      await setupChromiumWrapper().catch(() => undefined);
      return true;
    }
  }

  logger.info({ url: BINARY_URL }, "Downloading gosom Google Maps scraper binary…");
  try {
    const res = await fetch(BINARY_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(GMAPS_BINARY, buf);
    await chmod(GMAPS_BINARY, 0o755);
    await writeFile(VERSION_FILE, BINARY_VERSION);
    logger.info({ version: BINARY_VERSION, bytes: buf.length }, "gosom binary downloaded successfully");
    // Best-effort: fix Chrome wrapper if leftover from a previous failed run
    await setupChromiumWrapper().catch(() => undefined);
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to download gosom binary");
    return false;
  }
}

/** gosom Entry JSON structure (relevant fields only) */
interface GosomEntry {
  title?: string;
  address?: string;
  phone?: string;
  web_site?: string;
  category?: string;
  review_rating?: number;
  review_count?: number;
  link?: string;
  emails?: string[];
  latitude?: number;
  longitude?: number;
}

function buildQuery(params: GmapsSearchParams): string {
  const category = params.category?.trim();
  const city = params.city?.trim();
  if (category && city) return `${category} in ${city}`;
  if (category) return category;
  if (city) return city;
  return "commerces";
}

function dryRunResults(params: GmapsSearchParams, max: number): ScrapedGmapsPlace[] {
  const seed = (params.category || "exemple").slice(0, 20);
  const city = params.city || "Montréal";
  return Array.from({ length: Math.min(max, 5) }).map((_, i) => ({
    name: `${seed} Démo ${i + 1}`,
    address: `${100 + i} rue Démo, ${city}, QC`,
    phone: `+1 514-555-01${(i + 10).toString().padStart(2, "0")}`,
    website: `https://exemple-${i + 1}.ca`,
    category: params.category ?? null,
    rating: 4 + (i % 5) / 10,
    reviewsCount: 10 + i * 3,
    sourceUrl: `https://www.google.com/maps/search/${encodeURIComponent(buildQuery(params))}`,
    email: i === 0 ? `info@exemple-1.ca` : null,
  }));
}

function isSharedLibraryError(msg: string): boolean {
  return (
    msg.includes("shared libraries") ||
    msg.includes("libglib") ||
    msg.includes("cannot open shared object") ||
    msg.includes("No such file or directory") && msg.includes(".so")
  );
}

function buildGosomArgs(queryFile: string, outFile: string, depth: number): string[] {
  return [
    "-input", queryFile,
    "-results", outFile,
    "-json",
    "-depth", String(depth),
    "-email",
    "-exit-on-inactivity", "2m",
    "-c", "1",
    "-lang", "fr",
  ];
}

function spawnGosom(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(GMAPS_BINARY, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrLines: string[] = [];

    proc.stdout.on("data", (_chunk: Buffer) => { /* gosom writes JSON to the results file */ });
    proc.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) stderrLines.push(line);
    });

    proc.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        const errTail = stderrLines.slice(-10).join(" | ");
        reject(new Error(`gosom exited with code ${code}: ${errTail}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start gosom binary: ${err.message}`));
    });

    // Hard timeout: 5 minutes max (well past -exit-on-inactivity 2m)
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("gosom scrape timed out after 8 minutes"));
    }, 8 * 60 * 1000);

    proc.on("close", () => clearTimeout(timeout));
  });
}

/**
 * Scrape Google Maps using the gosom Go binary.
 *
 * Falls back to DRY_RUN demo data ONLY when SCRAPING_DRY_RUN=1 is explicitly
 * set.  When the binary is unavailable this throws so the job is marked failed
 * and no synthetic data is imported into the leads table.
 *
 * On NixOS the first run may fail because the playwright-downloaded Chrome
 * headless shell lacks glibc dependencies.  The function detects this, installs
 * a sh wrapper pointing to the Nix Chromium, and retries once automatically.
 */
export async function scrapeGmaps(
  params: GmapsSearchParams,
): Promise<ScrapedGmapsPlace[]> {
  const maxResults = Math.max(
    1,
    Math.min(params.maxResults ?? DEFAULT_MAX_RESULTS, HARD_CAP),
  );

  if (DRY_RUN) return dryRunResults(params, maxResults);

  if (!existsSync(GMAPS_BINARY)) {
    logger.warn("gosom binary not found — attempting download now");
    const ok = await ensureGmapsBinary();
    if (!ok) {
      throw new Error(
        "gosom binary unavailable — check network connectivity and retry",
      );
    }
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const queryFile = `/tmp/gmaps-query-${jobId}.txt`;
  const outFile = `/tmp/gmaps-out-${jobId}.json`;

  const query = buildQuery(params);
  await writeFile(queryFile, `${query}\n`);

  const depth = Math.max(1, Math.min(Math.ceil(maxResults / 12), 8));
  const chromiumPath = resolveChromiumPath();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH,
  };

  logger.info(
    { query, maxResults, depth, chromiumPath: chromiumPath ?? "none" },
    "Starting gosom scrape",
  );

  const args = buildGosomArgs(queryFile, outFile, depth);

  try {
    try {
      await spawnGosom(args, env);
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (!isSharedLibraryError(msg)) throw firstErr;

      // NixOS: downloaded Chrome headless shell lacks system libs.
      // Install the Nix Chromium wrapper and retry once.
      logger.info(
        { error: msg.slice(0, 120) },
        "Shared-library error on first attempt — installing Nix Chromium wrapper and retrying",
      );
      const wrapped = await setupChromiumWrapper();
      if (!wrapped) throw firstErr; // no Nix Chromium — give up

      // Retry with fresh files (output file may be empty/absent from first run)
      await spawnGosom(args, env);
    }
  } finally {
    await unlink(queryFile).catch(() => undefined);
  }

  // Parse JSON output — gosom -json writes NDJSON (one object per line),
  // NOT a JSON array.  Fall back to array parsing for forward-compatibility.
  let entries: GosomEntry[] = [];
  try {
    const raw = await readFile(outFile, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) {
      // empty file — no results
    } else if (trimmed.startsWith("[")) {
      // JSON array format (future-proof)
      const parsed = JSON.parse(trimmed) as unknown;
      entries = Array.isArray(parsed) ? (parsed as GosomEntry[]) : [];
    } else {
      // NDJSON format: one Entry object per line
      entries = trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GosomEntry);
    }
  } catch (err) {
    logger.error({ err }, "Failed to parse gosom JSON output");
  } finally {
    await unlink(outFile).catch(() => undefined);
  }

  logger.info(
    { count: entries.length, maxResults },
    "gosom returned entries — mapping to leads",
  );

  return entries
    .slice(0, maxResults)
    .map((e): ScrapedGmapsPlace => ({
      name: (e.title ?? "").trim() || "—",
      address: e.address?.trim() || null,
      phone: e.phone?.trim() || null,
      website: e.web_site?.trim() || null,
      category: e.category?.trim() || null,
      rating:
        typeof e.review_rating === "number" && Number.isFinite(e.review_rating)
          ? e.review_rating
          : null,
      reviewsCount:
        typeof e.review_count === "number" && e.review_count > 0
          ? e.review_count
          : null,
      sourceUrl: e.link?.trim() || "",
      // Use the first email found on the business website (via -email flag).
      email: Array.isArray(e.emails) && e.emails.length > 0
        ? (e.emails[0]?.trim() || null)
        : null,
    }))
    .filter((p) => p.name && p.name !== "—");
}
