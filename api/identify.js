// POST /api/identify  { image?: dataURL, text?: string }  ->  { product }
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getClient, getIdentifyModel, sendError } from "../lib/anthropic.js";
import { HttpError, fail, guard } from "../lib/auth.js";
import { IdentifyOutput, IdentifyRequest, parseImageDataUrl, zodMessage } from "../lib/schemas.js";
import { mockDelay, mockProduct } from "../lib/mock.js";

const SYSTEM = `You identify retail products sold in Australia (pharmacy, supermarket, health and beauty).
From the photo and/or the typed hint, return the canonical product name, brand, size or quantity (e.g. "200g", "60 capsules"),
variant, flavour or strength, any barcode digits you can clearly read (empty string if none), and a search_query that would
find this exact product on Australian retailer websites. Give confidence from 0 to 1.
Use empty strings for unknown fields. If the image is not a retail product, set is_product to false and explain why in notes.
When there is no photo and only a typed hint: do not guess the form, strength, flavour or variant beyond what the text says.
Use the hint (lightly tidied) as the name and search_query, fill only the fields the hint states, leave the rest empty, and
set confidence to 0.5 or lower. Only a photo justifies adding details that are not in the hint.`;

function buildContent({ image, text }) {
  const content = [];
  const img = image ? parseImageDataUrl(image) : null;
  if (img) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  const hint = text ? `Typed hint from the user: ${text}` : "";
  content.push({ type: "text", text: [hint, "Identify this product."].filter(Boolean).join("\n") });
  return content;
}

async function identifyWithClaude(body) {
  const response = await getClient().messages.parse({
    model: getIdentifyModel(),
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{ role: "user", content: buildContent(body) }],
    output_config: { format: zodOutputFormat(IdentifyOutput), effort: "low" },
  });
  if (response.stop_reason === "refusal") throw new HttpError(502, "model_refused");
  const p = response.parsed_output;
  if (!p) throw new HttpError(502, response.stop_reason === "max_tokens" ? "model_truncated" : "model_unparseable");
  return { ...p, search_query: p.search_query || p.name };
}

/** Vercel-style handler. */
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const parsed = IdentifyRequest.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "invalid_request", zodMessage(parsed.error));
  try {
    if (process.env.MOCK_API === "1") {
      await mockDelay();
      return res.status(200).json({ product: mockProduct() });
    }
    return res.status(200).json({ product: await identifyWithClaude(parsed.data) });
  } catch (err) {
    return sendError(res, err);
  }
}
