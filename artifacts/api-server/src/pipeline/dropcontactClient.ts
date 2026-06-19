/**
 * Dropcontact API client — RGPD/LCAP-compatible B2B email enrichment.
 *
 * Dropcontact is asynchronous: you POST a contact, receive a request_id, and
 * poll until the result is ready (usually 5-15 seconds). We poll for up to
 * 20 seconds total with exponential back-off.
 *
 * Returns null silently when:
 *  - DROPCONTACT_API_KEY is not set
 *  - Any network or API error occurs
 *  - Polling times out
 *
 * Docs: https://developer.dropcontact.com/
 */

import { logger } from "../lib/logger";

const BASE = "https://api.dropcontact.com";

function apiKey(): string | undefined {
  return process.env.DROPCONTACT_API_KEY;
}

export interface DropcontactInput {
  firstName: string;
  lastName: string;
  company?: string | null;
  website?: string | null;
}

export interface DropcontactResult {
  email: string;
  emailQualification: string; // e.g. "nominative", "generic"
}

interface DropcontactContact {
  first_name?: string;
  last_name?: string;
  company?: string;
  website?: string;
}

interface DropcontactResponse {
  request_id?: string;
  error?: string;
  reason?: string;
  success?: boolean;
  contacts?: Array<{
    email?: Array<{ email?: string; qualification?: string }>;
  }>;
  status?: string; // "pending" | "completed"
}

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_MS = 20_000;

async function pollResult(requestId: string, key: string): Promise<DropcontactResult | null> {
  const url = `${BASE}/contact/${requestId}`;
  const start = Date.now();

  while (Date.now() - start < POLL_MAX_MS) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const res = await fetch(url, {
        headers: { "X-Access-Token": key },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn({ status: res.status, requestId }, "Dropcontact poll non-OK");
        return null;
      }

      const body = (await res.json()) as DropcontactResponse;

      if (body.error || !body.success) {
        logger.warn({ reason: body.reason, requestId }, "Dropcontact poll returned error");
        return null;
      }

      if (body.status === "pending") continue;

      // Extract best email from first contact
      const contact = body.contacts?.[0];
      const emails = contact?.email ?? [];
      if (emails.length === 0) return null;

      const best = emails[0];
      const email = best?.email;
      if (!email || !email.includes("@")) return null;

      return {
        email: email.toLowerCase(),
        emailQualification: best?.qualification ?? "unknown",
      };
    } catch (err) {
      logger.warn({ err, requestId }, "Dropcontact poll request failed");
      return null;
    }
  }

  logger.warn({ requestId }, "Dropcontact poll timed out after 20s");
  return null;
}

/**
 * Enrich a contact via Dropcontact.
 * Submits the contact and polls for results.
 * Returns null if Dropcontact is not configured or no email was found.
 */
export async function dropcontactEnrich(
  input: DropcontactInput,
): Promise<DropcontactResult | null> {
  const key = apiKey();
  if (!key) return null;

  const contact: DropcontactContact = {};
  if (input.firstName.trim()) contact.first_name = input.firstName.trim();
  if (input.lastName.trim()) contact.last_name = input.lastName.trim();
  if (input.company?.trim()) contact.company = input.company.trim();
  if (input.website?.trim()) {
    // Strip protocol so Dropcontact recognises it as a domain
    contact.website = input.website
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
  }

  try {
    const res = await fetch(`${BASE}/contact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": key,
      },
      body: JSON.stringify({ data: [contact], siren: false, language: "FR" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 402 || res.status === 429) {
      logger.warn({ status: res.status }, "Dropcontact quota/rate-limit — skipping");
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, "Dropcontact POST non-OK response");
      return null;
    }

    const body = (await res.json()) as DropcontactResponse;

    if (body.error || !body.success) {
      logger.warn({ reason: body.reason }, "Dropcontact POST returned error");
      return null;
    }

    const requestId = body.request_id;
    if (!requestId) {
      logger.warn("Dropcontact POST returned no request_id");
      return null;
    }

    logger.info({ requestId }, "Dropcontact request submitted — polling for result");
    return await pollResult(requestId, key);
  } catch (err) {
    logger.warn({ err }, "Dropcontact enrich request failed");
    return null;
  }
}
