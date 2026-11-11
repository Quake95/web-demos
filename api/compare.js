// POST /api/compare  { product }  ->  prices, matchability and Chemist Warehouse match verdict
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  REPAIR_MODEL, buildCompareTools, createWithContinuations, extractJson, getClient, getModel, sendError, textBlocks,
} from "../lib/anthropic.js";
import { HttpError, fail, guard } from "../lib/auth.js";
import { RETAILER_DOMAINS, buildComparison } from "../lib/policy.js";
import { CompareRequest, ModelCompareOutput, normaliseModelCompare, zodMessage } from "../lib/schemas.js";
import { mockDelay, mockModelCompare } from "../lib/mock.js";

const SYSTEM = `You are a price researcher for Australian shoppers preparing a Chemist Warehouse price match.
Goal: find today's advertised price for the EXACT product (same brand, form, strength and pack size) at as many Australian
retailers as you can, always including Chemist Warehouse and Amcal themselves.
Method: first run one broad search for the product name to learn which pack sizes and forms actually exist and who stocks it.
Then run targeted searches or fetches for the exact pack at Chemist Warehouse, Amcal and the other retailers. Prefer the
retailer's own product page. Read the price shown today in AUD, whether it is a promo or special (and the was-price if shown),
the product URL, and stock status if visible.
If the exact pack size or variant is not sold somewhere, still report the closest product you priced there (same brand,
nearest pack size or form) with "exact": false and say what differs in notes, so the shopper can see it. Say in summary
when the exact product could not be found anywhere. Never invent a price or URL: only report what you actually saw.
Budget your searches; do not spend them all on one retailer.
When done, reply with ONLY a JSON object, no prose and no code fences, in this shape:
{"stores":[{"retailer":"Woolworths","url":"https://...","price":12.5,"was_price":15.0,"promo":true,"in_stock":true,"exact":true,"notes":"half price this week"}],"summary":"one or two sentences"}
Use null for was_price or in_stock when unknown. exact is true only when brand, form, strength and pack size all match.`;

/** One-line description of the product for the prompt. */
export function describeProduct(p) {
  const parts = [p.name, p.brand && `brand: ${p.brand}`, p.size && `size: ${p.size}`, p.variant && `variant: ${p.variant}`, p.barcode && `barcode: ${p.barcode}`];
  const line = parts.filter(Boolean).join(", ");
  return p.search_query ? `${line} (search hint: ${p.search_query})` : line;
}

function validate(candidate) {
  const r = ModelCompareOutput.safeParse(normaliseModelCompare(candidate));
  return r.success ? r.data : null;
}

/** Try the last text block, then all text joined. Returns validated output or null. */
function parseModelText(texts) {
  for (const t of [texts.at(-1), texts.join("\n")]) {
    if (!t) continue;
    try {
      const ok = validate(extractJson(t));
      if (ok) return ok;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function repair(rawText) {
  const response = await getClient().messages.parse({
    model: REPAIR_MODEL,
    max_tokens: 4000,
    system:
      "Extract the retailer price list from the text into the required structure. Include a store only when the text states " +
      "an explicit dollar price for this product at that store. If a page was blocked, failed to load, or shows no price, omit " +
      "that store entirely. Never guess, estimate or infer a price. Copy the summary from the text if there is one.",
    messages: [{ role: "user", content: rawText }],
    output_config: { format: zodOutputFormat(ModelCompareOutput) },
  });
  return response.parsed_output ?? null;
}

async function researchPrices(product) {
  const today = new Date().toISOString().slice(0, 10);
  const { response, usage } = await createWithContinuations(getClient(), {
    model: getModel(),
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: "user", content: `Today is ${today}. Product: ${describeProduct(product)}` }],
    tools: buildCompareTools(RETAILER_DOMAINS),
    output_config: { effort: "medium" },
  });
  if (response.stop_reason === "refusal") throw new HttpError(502, "model_refused");

  const texts = textBlocks(response.content);
  let out = parseModelText(texts);
  if (!out && texts.length) {
    console.warn("[compare] model output was not valid JSON; running repair. stop_reason=%s text=%s", response.stop_reason, texts.join("\n").slice(0, 3000));
    out = await repair(texts.join("\n"));
  }
  if (!out) throw new HttpError(502, response.stop_reason === "max_tokens" ? "model_truncated" : "model_unparseable");
  return { out, usage };
}

/** Vercel-style handler. */
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const parsed = CompareRequest.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "invalid_request", zodMessage(parsed.error));
  const product = parsed.data.product;
  try {
    let out, usage;
    if (process.env.MOCK_API === "1") {
      await mockDelay();
      out = mockModelCompare();
      usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, web_searches: 0 };
    } else {
      ({ out, usage } = await researchPrices(product));
    }
    return res.status(200).json({
      ...buildComparison(product, out),
      searched_at: new Date().toISOString(),
      usage,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
