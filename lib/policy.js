// Deterministic retailer classification and Chemist Warehouse price-match rules. No LLM involved.

export const RETAILERS = [
  { domain: "chemistwarehouse.com.au", name: "Chemist Warehouse", kind: "pharmacy", self: true },
  { domain: "amcal.com.au", name: "Amcal", kind: "pharmacy" },
  { domain: "priceline.com.au", name: "Priceline", kind: "pharmacy" },
  { domain: "terrywhitechemmart.com.au", name: "TerryWhite Chemmart", kind: "pharmacy" },
  { domain: "mychemist.com.au", name: "My Chemist", kind: "pharmacy" },
  { domain: "discountdrugstores.com.au", name: "Discount Drug Stores", kind: "pharmacy" },
  { domain: "bloomsthechemist.com.au", name: "Blooms The Chemist", kind: "pharmacy" },
  { domain: "pharmacy4less.com.au", name: "Pharmacy 4 Less", kind: "pharmacy" },
  { domain: "goodpricepharmacy.com.au", name: "Good Price Pharmacy", kind: "pharmacy" },
  { domain: "woolworths.com.au", name: "Woolworths", kind: "supermarket" },
  { domain: "coles.com.au", name: "Coles", kind: "supermarket" },
  { domain: "aldi.com.au", name: "ALDI", kind: "supermarket" },
  { domain: "iga.com.au", name: "IGA", kind: "supermarket" },
  { domain: "kmart.com.au", name: "Kmart", kind: "department" },
  { domain: "bigw.com.au", name: "Big W", kind: "department" },
  { domain: "target.com.au", name: "Target", kind: "department" },
  { domain: "amazon.com.au", name: "Amazon AU", kind: "marketplace" },
  { domain: "ebay.com.au", name: "eBay AU", kind: "marketplace" },
  { domain: "catch.com.au", name: "Catch", kind: "online_only" },
  { domain: "iherb.com", name: "iHerb", kind: "overseas" },
  { domain: "chemistdirect.com.au", name: "Chemist Direct", kind: "online_only" },
  { domain: "pharmacyonline.com.au", name: "Pharmacy Online", kind: "online_only" },
];

export const RETAILER_DOMAINS = RETAILERS.map((r) => r.domain);

export const CW_POLICY = [
  "Chemist Warehouse matches a lower advertised price from an Australian registered pharmacy or retailer on the identical product (same brand, size, variant), then takes a further 10% off the difference.",
  "The product must be in stock at the competitor. Clearance, bundle, loyalty-only and marketplace prices are excluded, and the limit is 3 per product.",
  "In store: show the competitor's current price (their website on your phone is fine). Online: contact Chemist Warehouse customer service with the product URL before ordering.",
  "This is a summary of published terms as at Nov 2026. Confirm current terms at chemistwarehouse.com.au.",
];

export const AMCAL_POLICY =
  "Amcal has no published price match policy. Franchise stores may match at their discretion, so ask in store and show them the competitor price.";

const BONUS_RATE = 0.1;

/** Round to whole cents. */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Lowercased hostname of a URL without a leading "www.", or "" if the URL is invalid. */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normName(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Classify a store row by URL hostname suffix, falling back to a fuzzy retailer-name match.
 * @param {string} url
 * @param {string} retailerName
 * @returns {{domain: string, name: string, kind: string, self: boolean}}
 */
export function classify(url, retailerName) {
  const host = hostnameOf(url);
  const byHost = RETAILERS.find((r) => host === r.domain || host.endsWith("." + r.domain));
  if (byHost) return { domain: byHost.domain, name: byHost.name, kind: byHost.kind, self: !!byHost.self };

  const wanted = normName(retailerName);
  if (wanted.length >= 3) {
    const byName = RETAILERS.find((r) => {
      const n = normName(r.name);
      return wanted === n || wanted.includes(n) || n.includes(wanted);
    });
    if (byName) return { domain: byName.domain, name: byName.name, kind: byName.kind, self: !!byName.self };
  }
  return { domain: host, name: retailerName || host || "Unknown", kind: "unknown", self: false };
}

/**
 * Decide whether Chemist Warehouse would match this competitor row.
 * @param {{kind: string, self?: boolean, in_stock?: boolean|null}} row
 * @returns {{matchable: "yes"|"maybe"|"no"|"self", reason: string}}
 */
export function matchability(row) {
  if (row.self) return { matchable: "self", reason: "This is Chemist Warehouse" };
  switch (row.kind) {
    case "pharmacy":
    case "supermarket":
    case "department":
      if (row.in_stock === false) return { matchable: "no", reason: "Competitor shows out of stock" };
      return { matchable: "yes", reason: "Australian retailer with physical stores" };
    case "marketplace":
      return { matchable: "no", reason: "Marketplaces are not matched" };
    case "online_only":
      return { matchable: "maybe", reason: "Online-only retailer: Chemist Warehouse online may match, stores usually won't" };
    case "overseas":
      return { matchable: "no", reason: "Overseas retailer" };
    default:
      return { matchable: "maybe", reason: "Check the retailer is an Australian registered pharmacy or retailer" };
  }
}

/**
 * What the customer pays after a match: competitor price minus 10% of the difference, floored at 0.
 * @param {number} cwPrice
 * @param {number} competitorPrice
 * @returns {{difference: number, bonus: number, you_pay: number}}
 */
export function computeYouPay(cwPrice, competitorPrice) {
  const diff = cwPrice - competitorPrice;
  const youPay = Math.max(0, round2(competitorPrice - BONUS_RATE * diff));
  return { difference: round2(diff), bonus: round2(BONUS_RATE * diff), you_pay: youPay };
}

function safeUrl(url) {
  return /^https?:\/\//i.test(String(url ?? "")) ? String(url) : "";
}

/**
 * Turn raw model store rows into enriched rows (domain, kind, matchable), sorted by price.
 * Rows without a positive finite price are dropped.
 * @param {Array<object>} rawStores
 */
export function enrichStores(rawStores) {
  return rawStores
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .map((s) => {
      const c = classify(s.url, s.retailer);
      const m = matchability({ kind: c.kind, self: c.self, in_stock: s.in_stock });
      return {
        retailer: c.kind === "unknown" ? s.retailer : c.name,
        domain: c.domain,
        url: safeUrl(s.url),
        price: round2(s.price),
        was_price: Number.isFinite(s.was_price) ? round2(s.was_price) : null,
        promo: !!s.promo,
        in_stock: s.in_stock ?? null,
        notes: s.notes ?? "",
        kind: c.kind,
        matchable: m.matchable,
        matchable_reason: m.reason,
        self: c.self,
      };
    })
    .sort((a, b) => a.price - b.price);
}

function lowest(rows) {
  return rows.reduce((best, r) => (!best || r.price < best.price ? r : best), null);
}

function brief(row) {
  return row ? { price: row.price, url: row.url } : null;
}

/** Chemist Warehouse outcome given its own row (or null) and the best matchable competitor (or null). */
function cwOutcome(cw, best) {
  if (!best) {
    return {
      status: "unknown",
      competitor_price: null,
      cw_price: cw ? cw.price : null,
      explanation: "No in-stock Australian retailer with a published price was found to match against.",
    };
  }
  if (!cw) {
    return {
      status: "unknown",
      competitor_price: best.price,
      cw_price: null,
      explanation: `Chemist Warehouse's own price wasn't found. The lowest matchable price is ${best.retailer} at $${best.price.toFixed(2)}; check the Chemist Warehouse page.`,
    };
  }
  if (best.price < cw.price) {
    return {
      status: "match",
      competitor_price: best.price,
      cw_price: cw.price,
      ...computeYouPay(cw.price, best.price),
      explanation: `Chemist Warehouse matches the price and takes a further 10% off the difference. Matching ${best.retailer}.`,
    };
  }
  return {
    status: "already_cheapest",
    competitor_price: best.price,
    cw_price: cw.price,
    explanation: "Chemist Warehouse is already at or below every matchable price found.",
  };
}

/**
 * Apply policy to the model's output: enrich rows, pick best matchable, compute the match outcome.
 * @param {object} product echoed product
 * @param {{stores: Array<object>, summary?: string}} modelOut validated model output
 */
export function buildComparison(product, modelOut) {
  const stores = enrichStores(modelOut.stores);
  const cw = lowest(stores.filter((s) => s.self));
  const amcal = lowest(stores.filter((s) => s.domain === "amcal.com.au"));
  const best = lowest(stores.filter((s) => s.matchable === "yes" && !s.self));

  const amcalMatch = {
    status: "ask_in_store",
    amcal_price: amcal ? amcal.price : null,
    competitor_price: best ? best.price : null,
    explanation: AMCAL_POLICY,
  };

  return {
    product,
    stores: stores.map(({ self, ...row }) => row),
    chemist_warehouse: brief(cw),
    amcal: brief(amcal),
    best_matchable: best ? { retailer: best.retailer, price: best.price, url: best.url } : null,
    match: { chemist_warehouse: cwOutcome(cw, best), amcal: amcalMatch },
    summary: modelOut.summary ?? "",
  };
}
