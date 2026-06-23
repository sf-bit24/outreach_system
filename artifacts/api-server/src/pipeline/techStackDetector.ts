/**
 * Tech stack detector — identifies tools/CMS/frameworks visible in a page's
 * HTML source, script URLs, and meta tags.
 *
 * Returns a deduplicated list of human-readable tool names. Never throws;
 * errors are swallowed and an empty array is returned.
 */

interface StackSignature {
  name: string;
  /** String patterns to match against the full HTML source (case-insensitive). */
  patterns: string[];
  category: "cms" | "analytics" | "crm" | "marketing" | "ecommerce" | "support" | "framework";
}

const SIGNATURES: StackSignature[] = [
  // CMS
  { name: "WordPress", patterns: ["wp-content/", "wp-includes/", 'name="generator" content="WordPress'], category: "cms" },
  { name: "Shopify", patterns: ["cdn.shopify.com", "shopify-analytics", "Shopify.theme"], category: "ecommerce" },
  { name: "Squarespace", patterns: ["squarespace.com", "squarespace-cdn"], category: "cms" },
  { name: "Wix", patterns: ["wixstatic.com", "wixsite.com", "_wix_"], category: "cms" },
  { name: "Webflow", patterns: ["webflow.com/css", "webflow.com/js", 'data-wf-site'], category: "cms" },
  { name: "Drupal", patterns: ["/sites/default/files", 'name="generator" content="Drupal', 'data-drupal'], category: "cms" },
  { name: "Joomla", patterns: ["/media/jui/", 'name="generator" content="Joomla'], category: "cms" },
  { name: "Ghost", patterns: ["ghost.io", "ghost/core"], category: "cms" },
  { name: "Magento", patterns: ["mage/", "Magento_", "requirejs/domReady"], category: "ecommerce" },
  { name: "WooCommerce", patterns: ["woocommerce", "wc-ajax"], category: "ecommerce" },
  { name: "BigCommerce", patterns: ["bigcommerce.com", "bcapp.dev"], category: "ecommerce" },
  // Analytics
  { name: "Google Analytics", patterns: ["google-analytics.com/analytics.js", "gtag/js?id=G-", "gtag/js?id=UA-", "GoogleAnalyticsObject"], category: "analytics" },
  { name: "Google Tag Manager", patterns: ["googletagmanager.com/gtm.js", "GTM-"], category: "analytics" },
  { name: "Google Analytics 4", patterns: ["gtag/js?id=G-", "GA_MEASUREMENT_ID"], category: "analytics" },
  { name: "Hotjar", patterns: ["static.hotjar.com", "hjSiteSettings", "_hjSettings"], category: "analytics" },
  { name: "Microsoft Clarity", patterns: ["clarity.ms/tag/", "clarity.ms/collect"], category: "analytics" },
  { name: "Mixpanel", patterns: ["cdn.mxpnl.com", "cdn4.mxpnl.com", "mixpanel.init"], category: "analytics" },
  { name: "Heap", patterns: ["cdn.heapanalytics.com", "heap.load("], category: "analytics" },
  { name: "Amplitude", patterns: ["cdn.amplitude.com", "amplitude.getInstance"], category: "analytics" },
  { name: "Segment", patterns: ["cdn.segment.com/analytics.js", "segment.io", 'analytics.load("'], category: "analytics" },
  { name: "PostHog", patterns: ["posthog-js", "posthog.init(", "app.posthog.com"], category: "analytics" },
  // CRM & Sales
  { name: "HubSpot", patterns: ["js.hs-scripts.com", "hubspot.com/hs/hsstatic", "hbspt.forms.create", "hs-analytics"], category: "crm" },
  { name: "Salesforce", patterns: ["salesforce.com", "force.com", "sfdcstatic.com"], category: "crm" },
  { name: "Pipedrive", patterns: ["pipedrive.com", "dealbot"], category: "crm" },
  { name: "Zoho CRM", patterns: ["zoho.com/crm", "salesiq.zoho.com"], category: "crm" },
  // Marketing & Email
  { name: "Mailchimp", patterns: ["chimpstatic.com", "mailchimp.com", "mc.us"], category: "marketing" },
  { name: "ActiveCampaign", patterns: ["activecampaign.com", "activehosted.com"], category: "marketing" },
  { name: "Klaviyo", patterns: ["klaviyo.com", 'company_id: "'], category: "marketing" },
  { name: "Brevo (Sendinblue)", patterns: ["sendinblue.com", "brevo.com", "sibautomation.com"], category: "marketing" },
  { name: "ConvertKit", patterns: ["convertkit.com", "f.convertkit.com"], category: "marketing" },
  // Live chat & Support
  { name: "Intercom", patterns: ["widget.intercom.io", "intercomSettings", 'app_id: "'], category: "support" },
  { name: "Drift", patterns: ["js.driftt.com", "drift.load("], category: "support" },
  { name: "Zendesk", patterns: ["static.zdassets.com", "zendeskwidget", "zE("], category: "support" },
  { name: "Freshdesk", patterns: ["freshdesk.com", "freshwidget.com"], category: "support" },
  { name: "Crisp", patterns: ["client.crisp.chat", "CRISP_WEBSITE_ID"], category: "support" },
  { name: "LiveChat", patterns: ["cdn.livechatinc.com", "lcw_open"], category: "support" },
  // Frameworks (less discriminating, lower priority)
  { name: "React", patterns: ["react-dom.min.js", "__reactFiber", "data-reactroot"], category: "framework" },
  { name: "Vue.js", patterns: ["vue.min.js", "__vue__", "vue.runtime.min.js"], category: "framework" },
  { name: "Next.js", patterns: ["_next/static", "__NEXT_DATA__"], category: "framework" },
  { name: "Nuxt", patterns: ["_nuxt/", "__nuxt"], category: "framework" },
  // Ads
  { name: "Facebook Pixel", patterns: ["connect.facebook.net/en_US/fbevents.js", "fbq('init'", "fbq(\"init\""], category: "marketing" },
  { name: "LinkedIn Insight", patterns: ["snap.licdn.com", "_linkedin_data_partner_id"], category: "marketing" },
  { name: "Google Ads", patterns: ["googleadservices.com", "gtag('event', 'conversion'", 'gtag("event", "conversion"'], category: "marketing" },
];

const CATEGORY_PRIORITY: Record<string, number> = {
  crm: 0,
  ecommerce: 1,
  marketing: 2,
  support: 3,
  analytics: 4,
  cms: 5,
  framework: 6,
};

const FETCH_TIMEOUT_MS = 8_000;
const UA = "Mozilla/5.0 (compatible; OutreachIQ/1.0)";

function normalizeUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and run tech-stack detection on its HTML.
 * Returns empty array on any error.
 */
export async function fetchAndDetectTechStack(
  rawUrl: string | null | undefined,
): Promise<string[]> {
  const url = normalizeUrl(rawUrl ?? "");
  if (!url) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res || !res.ok) return [];
    const html = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return detectTechStack(html, headers);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect tech stack from the HTML content of a page (and optionally its HTTP
 * response headers).  Returns up to 10 detected tools sorted by category
 * relevance (CRM / ecommerce first — most useful for personalization).
 */
export function detectTechStack(
  html: string,
  headers?: Record<string, string>,
): string[] {
  const lower = html.toLowerCase();
  const headersStr = headers
    ? Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
        .toLowerCase()
    : "";

  const detected: { name: string; category: string }[] = [];
  const seen = new Set<string>();

  for (const sig of SIGNATURES) {
    if (seen.has(sig.name)) continue;
    const match = sig.patterns.some(
      (p) =>
        lower.includes(p.toLowerCase()) ||
        headersStr.includes(p.toLowerCase()),
    );
    if (match) {
      detected.push({ name: sig.name, category: sig.category });
      seen.add(sig.name);
    }
  }

  // Sort by category relevance
  detected.sort(
    (a, b) =>
      (CATEGORY_PRIORITY[a.category] ?? 99) -
      (CATEGORY_PRIORITY[b.category] ?? 99),
  );

  return detected.slice(0, 10).map((d) => d.name);
}
