/**
 * Hunter.io API client — domain search + email finder.
 *
 * Both functions return null silently when:
 *  - HUNTER_API_KEY is not set
 *  - The API responds with 402 (quota exceeded) or 429 (rate limit)
 *  - Any network error occurs
 *
 * Docs: https://hunter.io/api-documentation/v2
 */

import { logger } from "../lib/logger";

const BASE = "https://api.hunter.io/v2";

function apiKey(): string | undefined {
  return process.env.HUNTER_API_KEY;
}

export interface HunterEmailEntry {
  email: string;
  score: number;
  type: string; // "personal" | "generic" | ...
  firstName?: string | null;
  lastName?: string | null;
  position?: string | null;
}

export interface HunterFinderResult {
  email: string;
  score: number;
}

/**
 * Hunter Domain Search — returns all publicly-known addresses for a domain,
 * sorted by score descending (highest confidence first).
 * Returns [] when nothing was found or the key is absent.
 */
export async function hunterDomainSearch(
  domain: string,
): Promise<HunterEmailEntry[]> {
  const key = apiKey();
  if (!key) return [];

  const url = `${BASE}/domain-search?domain=${encodeURIComponent(domain)}&api_key=${key}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 402 || res.status === 429) {
      logger.warn({ status: res.status }, "Hunter domain-search quota/rate-limit — skipping");
      return [];
    }
    if (!res.ok) {
      logger.warn({ status: res.status, domain }, "Hunter domain-search non-OK response");
      return [];
    }

    const body = (await res.json()) as {
      data?: {
        emails?: Array<{
          value?: string;
          confidence?: number;
          type?: string;
          first_name?: string | null;
          last_name?: string | null;
          position?: string | null;
        }>;
      };
    };

    const raw = body?.data?.emails ?? [];
    return raw
      .filter((e) => typeof e.value === "string" && e.value.includes("@"))
      .map((e) => ({
        email: e.value!.toLowerCase(),
        score: e.confidence ?? 0,
        type: e.type ?? "unknown",
        firstName: e.first_name ?? null,
        lastName: e.last_name ?? null,
        position: e.position ?? null,
      }))
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    logger.warn({ err, domain }, "Hunter domain-search request failed");
    return [];
  }
}

/**
 * Hunter Email Finder — predicts the likely email address for a person at a
 * domain. Returns null when Hunter is not configured, quota is exhausted, or
 * no confident result was found (score < 50).
 *
 * ⚠ This returns a *predicted* address — it must still be confirmed via SMTP
 * before being adopted.
 */
export async function hunterEmailFinder(
  domain: string,
  firstName: string,
  lastName: string,
): Promise<HunterFinderResult | null> {
  const key = apiKey();
  if (!key) return null;
  if (!firstName.trim() || !lastName.trim()) return null;

  const params = new URLSearchParams({
    domain,
    first_name: firstName.trim(),
    last_name: lastName.trim(),
    api_key: key,
  });
  const url = `${BASE}/email-finder?${params.toString()}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 402 || res.status === 429) {
      logger.warn({ status: res.status }, "Hunter email-finder quota/rate-limit — skipping");
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, domain }, "Hunter email-finder non-OK response");
      return null;
    }

    const body = (await res.json()) as {
      data?: { email?: string; score?: number };
    };

    const email = body?.data?.email;
    const score = body?.data?.score ?? 0;

    // Only use results with reasonable confidence
    if (!email || score < 50) return null;

    return { email: email.toLowerCase(), score };
  } catch (err) {
    logger.warn({ err, domain }, "Hunter email-finder request failed");
    return null;
  }
}
