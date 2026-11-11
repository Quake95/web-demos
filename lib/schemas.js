// zod schemas. Output schemas (used with structured output) stay plain: no defaults, transforms, refinements.
import { z } from "zod";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * Parse a `data:image/...;base64,...` URL.
 * @param {string} dataUrl
 * @returns {{media_type: string, data: string} | null} null when malformed, wrong type, or too large
 */
export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const marker = ";base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx < 0) return null;
  const mediaType = dataUrl.slice(5, idx).toLowerCase();
  const data = dataUrl.slice(idx + marker.length);
  if (!ALLOWED_MEDIA.includes(mediaType)) return null;
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return { media_type: mediaType, data };
}

/** Request body for POST /api/identify. */
export const IdentifyRequest = z
  .object({
    image: z.string().optional().refine((v) => v === undefined || parseImageDataUrl(v) !== null, {
      message: "image must be a base64 data URL (jpeg, png, webp or gif) of at most 4 MB",
    }),
    text: z.string().trim().max(500).optional(),
  })
  .refine((b) => !!b.image || !!b.text, { message: "Provide an image or text" });

/** Model output for identify (structured output, plain types only). */
export const IdentifyOutput = z.object({
  is_product: z.boolean(),
  name: z.string(),
  brand: z.string(),
  size: z.string(),
  variant: z.string(),
  barcode: z.string(),
  search_query: z.string(),
  confidence: z.number(),
  notes: z.string(),
});

const optText = z.string().max(300).nullish();

/** Product as sent by the client to POST /api/compare. */
export const CompareRequest = z.object({
  product: z.object({
    name: z.string().trim().min(1).max(300),
    brand: optText,
    size: optText,
    variant: optText,
    barcode: optText,
    search_query: optText,
  }),
});

/** What the model must emit for compare (also used as the repair-call structured output). */
export const ModelCompareOutput = z.object({
  stores: z.array(
    z.object({
      retailer: z.string(),
      url: z.string(),
      price: z.number(),
      was_price: z.number().nullable(),
      promo: z.boolean(),
      in_stock: z.boolean().nullable(),
      exact: z.boolean().nullable(),
      notes: z.string(),
    }),
  ),
  summary: z.string(),
});

/**
 * Fill optional fields the model often omits so strict validation doesn't reject good data.
 * @param {unknown} raw parsed JSON
 */
export function normaliseModelCompare(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.stores)) return raw;
  return {
    summary: typeof raw.summary === "string" ? raw.summary : "",
    stores: raw.stores.map((s) =>
      s && typeof s === "object"
        ? {
            ...s,
            was_price: s.was_price ?? null,
            promo: s.promo ?? false,
            in_stock: s.in_stock ?? null,
            exact: s.exact ?? null,
            notes: s.notes ?? "",
            url: s.url ?? "",
          }
        : s,
    ),
  };
}

/** Flatten a zod error into one short string. */
export function zodMessage(err) {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}
