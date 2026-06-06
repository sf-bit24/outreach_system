import { promises as dns } from "node:dns";
import net from "node:net";

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

// ─── SMTP mailbox verification (RCPT TO) ───

/**
 * Outcome of an SMTP RCPT TO probe.
 * - `deliverable`  : the mail server accepted RCPT TO for this exact mailbox
 *                    AND rejected a random probe address (not a catch-all).
 *                    This is the ONLY status that is safe to mark "verified".
 * - `undeliverable`: the server permanently rejected the mailbox (5xx).
 * - `risky`        : the domain is a catch-all — it accepts every address, so
 *                    we cannot confirm this specific mailbox exists.
 * - `unknown`      : no conclusion (timeout, port 25 blocked, greylisting,
 *                    temporary 4xx). Never treat as verified.
 */
export type SmtpVerifyStatus =
  | "deliverable"
  | "undeliverable"
  | "risky"
  | "unknown";

export interface SmtpVerifyResult {
  status: SmtpVerifyStatus;
  code: number | null;
  reason: string;
  catchAll: boolean;
}

const SMTP_PORT = 25;
const SMTP_TIMEOUT_MS = 10_000;

/**
 * When `SMTP_VERIFY_DRY_RUN=1` the network probe is skipped. Useful for local
 * testing where outbound port 25 is blocked. Any syntactically-valid address
 * whose local part does not contain "invalid"/"nonexistent" is treated as
 * deliverable so the enrichment pipeline can be exercised end-to-end.
 */
export const SMTP_VERIFY_DRY_RUN = process.env.SMTP_VERIFY_DRY_RUN === "1";

function heloHost(): string {
  const fromEnv = process.env.SMTP_HELO_HOST;
  if (fromEnv) return fromEnv;
  const dev = process.env.REPLIT_DEV_DOMAIN;
  if (dev) return dev;
  return "outreachiq.app";
}

function probeFrom(): string {
  return process.env.SMTP_VERIFY_FROM ?? `verify@${heloHost()}`;
}

interface SmtpReply {
  code: number;
  text: string;
}

/**
 * Minimal SMTP client that runs a HELO → MAIL FROM → RCPT TO conversation and
 * reports the RCPT TO result for both the target mailbox and a random control
 * address (to detect catch-all domains). Never sends DATA — nothing is mailed.
 */
function smtpProbe(
  exchange: string,
  target: string,
  controlAddress: string,
): Promise<{ targetCode: number; controlCode: number; lastText: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: exchange, port: SMTP_PORT });
    socket.setEncoding("utf8");
    socket.setTimeout(SMTP_TIMEOUT_MS);

    let buffer = "";
    let resolveReply: ((reply: SmtpReply) => void) | null = null;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.on("timeout", () => fail(new Error("SMTP timeout")));
    socket.on("error", (err) => fail(err));
    socket.on("close", () => {
      if (!settled) fail(new Error("SMTP connection closed unexpectedly"));
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // A complete SMTP reply ends with a line "NNN <space>...".
      const lines = buffer.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = /^(\d{3})([ -])/.exec(line);
        if (m && m[2] === " ") {
          const code = Number(m[1]);
          buffer = lines.slice(i + 1).join("\n");
          const cb = resolveReply;
          resolveReply = null;
          if (cb) cb({ code, text: line });
          return;
        }
      }
    });

    const waitFor = (): Promise<SmtpReply> =>
      new Promise((res) => {
        resolveReply = res;
      });

    const send = (cmd: string): Promise<SmtpReply> => {
      socket.write(cmd + "\r\n");
      return waitFor();
    };

    (async () => {
      try {
        const greeting = await waitFor();
        if (greeting.code !== 220) {
          throw new Error(`Unexpected greeting: ${greeting.text}`);
        }
        const helo = heloHost();
        let ehlo = await send(`EHLO ${helo}`);
        if (ehlo.code >= 400) {
          ehlo = await send(`HELO ${helo}`);
          if (ehlo.code >= 400) {
            throw new Error(`HELO rejected: ${ehlo.text}`);
          }
        }
        const mailFrom = await send(`MAIL FROM:<${probeFrom()}>`);
        if (mailFrom.code >= 400) {
          throw new Error(`MAIL FROM rejected: ${mailFrom.text}`);
        }
        const rcpt = await send(`RCPT TO:<${target}>`);
        const control = await send(`RCPT TO:<${controlAddress}>`);
        socket.write("QUIT\r\n");
        settled = true;
        socket.end();
        resolve({
          targetCode: rcpt.code,
          controlCode: control.code,
          lastText: rcpt.text,
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

function randomLocalPart(): string {
  return `no-such-user-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Verify that a mailbox actually exists by performing an SMTP RCPT TO against
 * the domain's mail exchanger. Tries each MX (lowest priority first) until one
 * yields a usable answer. Returns a conservative `unknown` whenever the probe
 * cannot reach a conclusion (port blocked, timeout, greylisting) — callers must
 * only mark an address verified on `deliverable`.
 */
export async function verifyEmailSmtp(
  email: string,
): Promise<SmtpVerifyResult> {
  if (!email || !SYNTAX_RE.test(email)) {
    return {
      status: "undeliverable",
      code: null,
      reason: "Invalid syntax",
      catchAll: false,
    };
  }

  const [, domain] = email.toLowerCase().split("@");
  if (!domain) {
    return {
      status: "undeliverable",
      code: null,
      reason: "Missing domain",
      catchAll: false,
    };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      status: "undeliverable",
      code: null,
      reason: "Disposable email domain",
      catchAll: false,
    };
  }

  if (SMTP_VERIFY_DRY_RUN) {
    const local = email.toLowerCase().split("@")[0];
    const bad = /invalid|nonexistent|no-such-user/.test(local);
    return bad
      ? {
          status: "undeliverable",
          code: 550,
          reason: "Dry-run: simulated rejection",
          catchAll: false,
        }
      : {
          status: "deliverable",
          code: 250,
          reason: "Dry-run: simulated acceptance",
          catchAll: false,
        };
  }

  let mxRecords: { exchange: string; priority: number }[] = [];
  try {
    mxRecords = await dns.resolveMx(domain);
  } catch {
    return {
      status: "undeliverable",
      code: null,
      reason: `No MX records for ${domain}`,
      catchAll: false,
    };
  }
  if (mxRecords.length === 0) {
    return {
      status: "undeliverable",
      code: null,
      reason: `Domain ${domain} cannot receive email`,
      catchAll: false,
    };
  }

  const exchanges = mxRecords
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((r) => r.exchange);

  const control = `${randomLocalPart()}@${domain}`;
  let lastError = "";

  for (const exchange of exchanges) {
    try {
      const { targetCode, controlCode, lastText } = await smtpProbe(
        exchange,
        email.toLowerCase(),
        control,
      );

      const targetOk = targetCode >= 200 && targetCode < 300;
      const controlOk = controlCode >= 200 && controlCode < 300;

      if (targetOk && controlOk) {
        return {
          status: "risky",
          code: targetCode,
          reason: "Catch-all domain — accepts any address",
          catchAll: true,
        };
      }
      if (targetOk) {
        return {
          status: "deliverable",
          code: targetCode,
          reason: "Mailbox accepted by SMTP server",
          catchAll: false,
        };
      }
      if (targetCode >= 500) {
        return {
          status: "undeliverable",
          code: targetCode,
          reason: `Mailbox rejected: ${lastText}`.slice(0, 200),
          catchAll: false,
        };
      }
      // 4xx (greylisting / temporary) — try the next MX, then fall through.
      lastError = lastText;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: "unknown",
    code: null,
    reason: lastError
      ? `SMTP probe inconclusive: ${lastError}`.slice(0, 200)
      : "SMTP probe inconclusive",
    catchAll: false,
  };
}
