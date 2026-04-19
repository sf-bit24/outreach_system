import { logger } from "../lib/logger";

/**
 * Apollo.io REST API client.
 * Docs: https://docs.apollo.io/reference/people-search
 *
 * Auth: X-Api-Key header. Free / starter plans return masked emails
 * (e.g. "email_not_unlocked@domain.com") unless the account has unlock credits.
 */

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export interface ApolloSearchInput {
  keywords?: string;
  jobTitles?: string[];
  locations?: string[];
  industries?: string[];
  companyName?: string;
  page?: number;
  perPage?: number;
}

export interface ApolloPerson {
  firstName: string;
  lastName: string;
  email: string | null;
  emailStatus: string | null;
  jobTitle: string;
  linkedinUrl: string | null;
  company: string;
  website: string | null;
  industry: string | null;
  location: string | null;
  companySize: string | null;
}

export interface ApolloSearchResult {
  people: ApolloPerson[];
  pagination: {
    page: number;
    perPage: number;
    totalEntries: number;
    totalPages: number;
  };
}

function getApiKey(): string {
  const key = process.env["APOLLO_API_KEY"];
  if (!key) throw new Error("APOLLO_API_KEY not configured");
  return key;
}

function isMaskedEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  return email.includes("email_not_unlocked") || email.includes("domain.com");
}

function normalizePerson(raw: any): ApolloPerson {
  const org = raw?.organization ?? {};
  const email = isMaskedEmail(raw?.email) ? null : (raw?.email as string);
  return {
    firstName: raw?.first_name ?? "",
    lastName: raw?.last_name ?? "",
    email,
    emailStatus: raw?.email_status ?? null,
    jobTitle: raw?.title ?? "",
    linkedinUrl: raw?.linkedin_url ?? null,
    company: org?.name ?? raw?.organization_name ?? "",
    website: org?.website_url ?? null,
    industry: org?.industry ?? null,
    location: [raw?.city, raw?.state, raw?.country].filter(Boolean).join(", ") || null,
    companySize: org?.estimated_num_employees
      ? String(org.estimated_num_employees)
      : null,
  };
}

export async function searchPeople(
  input: ApolloSearchInput,
): Promise<ApolloSearchResult> {
  const body: Record<string, unknown> = {
    page: input.page ?? 1,
    per_page: Math.min(input.perPage ?? 25, 100),
  };
  if (input.keywords) body["q_keywords"] = input.keywords;
  if (input.jobTitles?.length) body["person_titles"] = input.jobTitles;
  if (input.locations?.length) body["person_locations"] = input.locations;
  if (input.industries?.length) body["organization_industry_tag_ids"] = input.industries;
  if (input.companyName) body["q_organization_name"] = input.companyName;

  logger.info({ body }, "Apollo people search");

  const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": getApiKey(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, text }, "Apollo API error");
    throw new Error(`Apollo API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const people: ApolloPerson[] = Array.isArray(data?.people)
    ? data.people.map(normalizePerson)
    : [];

  return {
    people,
    pagination: {
      page: data?.pagination?.page ?? 1,
      perPage: data?.pagination?.per_page ?? body["per_page"] as number,
      totalEntries: data?.pagination?.total_entries ?? people.length,
      totalPages: data?.pagination?.total_pages ?? 1,
    },
  };
}

export function isConfigured(): boolean {
  return Boolean(process.env["APOLLO_API_KEY"]);
}

export interface ApolloMatchInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  organizationName?: string;
  domain?: string;
  linkedinUrl?: string;
}

/**
 * People Match endpoint — works on free Apollo plans (limited credits).
 * Provide whatever you know (name + company OR email OR linkedin) and
 * Apollo will return its best-matching person record.
 */
export async function matchPerson(
  input: ApolloMatchInput,
): Promise<ApolloPerson | null> {
  const body: Record<string, unknown> = { reveal_personal_emails: false };
  if (input.firstName) body["first_name"] = input.firstName;
  if (input.lastName) body["last_name"] = input.lastName;
  if (input.email) body["email"] = input.email;
  if (input.organizationName) body["organization_name"] = input.organizationName;
  if (input.domain) body["domain"] = input.domain;
  if (input.linkedinUrl) body["linkedin_url"] = input.linkedinUrl;

  logger.info({ body }, "Apollo people match");

  const res = await fetch(`${APOLLO_BASE}/people/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": getApiKey(),
    },
    body: JSON.stringify(body),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, text }, "Apollo match error");
    throw new Error(`Apollo API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  if (!data?.person) return null;
  return normalizePerson(data.person);
}
