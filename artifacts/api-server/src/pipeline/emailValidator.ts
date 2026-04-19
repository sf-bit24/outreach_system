import { promises as dns } from "node:dns";

export interface EmailValidationResult {
  valid: boolean;
  reason: string;
  hasMxRecord: boolean;
}

const SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "tempmail.com",
  "10minutemail.com",
  "guerrillamail.com",
  "yopmail.com",
]);

const ROLE_PREFIXES = new Set([
  "info",
  "contact",
  "support",
  "noreply",
  "no-reply",
  "admin",
  "sales",
  "hello",
]);

export async function validateEmail(
  email: string,
): Promise<EmailValidationResult> {
  if (!email || !SYNTAX_RE.test(email)) {
    return { valid: false, reason: "Invalid syntax", hasMxRecord: false };
  }

  const [local, domain] = email.toLowerCase().split("@");
  if (!domain) {
    return { valid: false, reason: "Missing domain", hasMxRecord: false };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      valid: false,
      reason: "Disposable email domain",
      hasMxRecord: false,
    };
  }

  let mxRecords: { exchange: string; priority: number }[] = [];
  try {
    mxRecords = await dns.resolveMx(domain);
  } catch (err) {
    return {
      valid: false,
      reason: `No MX records for ${domain}`,
      hasMxRecord: false,
    };
  }

  if (mxRecords.length === 0) {
    return {
      valid: false,
      reason: `Domain ${domain} cannot receive email`,
      hasMxRecord: false,
    };
  }

  if (ROLE_PREFIXES.has(local)) {
    return {
      valid: true,
      reason: "Valid (role-based address — lower priority)",
      hasMxRecord: true,
    };
  }

  return {
    valid: true,
    reason: "Valid syntax with MX record",
    hasMxRecord: true,
  };
}
