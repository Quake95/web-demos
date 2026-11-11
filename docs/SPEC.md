# Price Match Helper — Build Spec

A phone-first web app for one person (Steph). She snaps a photo of a product (or types its
name), the app identifies it, searches Australian retailers for cheaper prices, and tells her
whether Chemist Warehouse (and, at the store's discretion, Amcal) should price match it.

Static front-end + Vercel serverless functions. One third-party dependency at runtime: the
Anthropic API (vision for identification, built-in web search / web fetch for price research).

## Repo layout

```
index.html                 the app (single file, vanilla HTML/CSS/JS, PWA)
manifest.webmanifest       PWA manifest
sw.js                      minimal service worker (installability + cache of static shell only; never caches /api)
icons/icon-192.png         app icons (plus icon-512.png, apple-touch-icon.png)
api/identify.js            POST  image or text  -> product identity
api/compare.js             POST  product identity -> prices + match verdicts
lib/anthropic.js           SDK client factory + model/tool constants
lib/auth.js                PIN check + in-memory rate limit + JSON body helpers
lib/policy.js              retailer classification + Chemist Warehouse match rules (deterministic, no LLM)
lib/schemas.js             zod schemas for request bodies and model outputs
lib/mock.js                canned responses for MOCK_API=1
scripts/dev-server.mjs     local server: serves static files + mounts api/*.js with Vercel's (req,res) signature
test/*.test.mjs            node:test unit tests (policy, schemas, auth, JSON extraction)
vercel.json, package.json, .env.example, .gitignore
tradie/, accountant/       old demos, untouched
```

Node 22, ESM (`"type": "module"`). Dependencies: `@anthropic-ai/sdk` (latest), `zod` (v4). Dev deps: none
beyond node:test; Playwright is preinstalled globally in the build environment, do not add it to package.json.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes (prod) | Anthropic API key. SDK reads it automatically. |
| `APP_PIN` | yes (prod) | 4-8 digit PIN the app must send in header `x-app-pin`. |
| `CLAUDE_MODEL` | no | default `claude-opus-5-5`. |
| `MOCK_API` | no | `1` returns canned data, no API calls. Used for local UI testing. |
| `MAX_SEARCHES` | no | web_search `max_uses`, default 8. |

## Auth and limits (lib/auth.js)

- Every `/api/*` request must carry header `x-app-pin` equal to `APP_PIN`. Missing/wrong -> `401 {error:"bad_pin"}`.
  If `APP_PIN` is unset and `MOCK_API` is not `1` -> `503 {error:"not_configured"}`.
- Compare with constant-time comparison (`crypto.timingSafeEqual` on equal-length buffers).
- In-memory rate limit per IP (`x-forwarded-for` first value): 30 requests per 10 minutes -> `429 {error:"rate_limited"}`.
  Best-effort only; the PIN is the real guard.
- Only `POST`; otherwise `405`. Body must be JSON `<= 6 MB`.
- All errors are JSON `{error: string, message?: string}`. Never leak stack traces or the API key.

## POST /api/identify

Request (one of `image` or `text` required):
```json
{ "image": "data:image/jpeg;base64,....", "text": "optional typed name or extra hint" }
```
- Accept `data:` URLs with media type `image/jpeg|png|webp|gif`; strip the prefix, validate base64 length <= 5 MB.
- Call Claude (vision) with the image and/or text. Use `client.messages.parse` with `zodOutputFormat` so the
  response is schema-validated. Model: `CLAUDE_MODEL`. `max_tokens: 2000`. `output_config.effort: "low"`.
- System prompt: identify a retail product sold in Australia (pharmacy, supermarket, health & beauty). Return the
  canonical product name, brand, size/quantity (e.g. "200g", "60 capsules"), variant/flavour/strength, any
  barcode digits visible, a `search_query` string that would find this exact product on Australian retailer
  sites, and `confidence` 0-1. If the image is not a product, return `is_product:false` and say why in `notes`.

Response 200:
```json
{
  "product": {
    "is_product": true,
    "name": "Nurofen Zavance 256mg Tablets",
    "brand": "Nurofen",
    "size": "96 pack",
    "variant": "Zavance 256mg",
    "barcode": "9300631...",
    "search_query": "Nurofen Zavance 256mg 96 tablets",
    "confidence": 0.9,
    "notes": ""
  }
}
```

## POST /api/compare

Request:
```json
{ "product": { "name": "...", "brand": "...", "size": "...", "variant": "...", "barcode": "...", "search_query": "..." } }
```
Server flow:
1. Validate with zod. Build a one-line product description.
2. One Claude request with server tools (regular `client.messages.create`, not beta):
   - `{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES, user_location: { type: "approximate", country: "AU" }, allowed_domains: RETAILER_DOMAINS }`
   - `{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, allowed_domains: RETAILER_DOMAINS }`
   - Do NOT also declare code_execution.
   - `max_tokens: 8000`, `output_config.effort: "medium"`.
   - Handle `stop_reason === "pause_turn"`: push `{role:"assistant", content: response.content}` and call again, up to 4 continuations.
   - Handle `stop_reason === "refusal"` -> `502 {error:"model_refused"}`.
3. System prompt tells the model: find the current advertised price for this exact product (same brand, size,
   variant) at each Australian retailer it can, including Chemist Warehouse and Amcal themselves. Prefer the
   retailer's own product page. Report the price shown today, whether it is a promo/special, the product URL,
   stock status if visible. Skip different sizes or multipacks. When done, reply with ONLY a JSON object in the
   shape below, no prose, no code fences.
4. Extract the JSON from the final text block (`lib/anthropic.js` exports `extractJson(text)`: strip code fences
   if present, find first `{` to last `}`, `JSON.parse`). Validate with zod `ModelCompareOutput`. If invalid, make one
   repair call with `client.messages.parse` + `zodOutputFormat(ModelCompareOutput)` on `claude-haiku-5-5`
   passing the raw text, `max_tokens: 4000`.
5. Run `lib/policy.js` over every store row to set `kind`, `matchable`, `matchable_reason` deterministically
   (the model only supplies retailer name, url, price, promo, in_stock, notes). Compute `best_matchable`
   (lowest price among `matchable === "yes"` rows, excluding Chemist Warehouse itself) and the Chemist Warehouse
   match outcome.

Model output shape (what the model must emit):
```json
{
  "stores": [
    { "retailer": "Woolworths", "url": "https://www.woolworths.com.au/...", "price": 12.5,
      "was_price": 15.0, "promo": true, "in_stock": true, "notes": "half price this week" }
  ],
  "summary": "one or two sentences"
}
```
`price` is a number in AUD, `was_price` optional, `in_stock` true/false/null.

Response 200:
```json
{
  "product": { ...echoed... },
  "stores": [ { "retailer": "Woolworths", "domain": "woolworths.com.au", "url": "...", "price": 12.5, "was_price": 15, "promo": true,
                "in_stock": true, "notes": "...", "kind": "supermarket", "matchable": "yes", "matchable_reason": "Australian retailer with physical stores" } ],
  "chemist_warehouse": { "price": 14.99, "url": "..." } | null,
  "amcal": { "price": 16.49, "url": "..." } | null,
  "best_matchable": { "retailer": "Woolworths", "price": 12.5, "url": "..." } | null,
  "match": {
    "chemist_warehouse": {
      "status": "match" | "already_cheapest" | "unknown",
      "competitor_price": 12.5, "cw_price": 14.99,
      "difference": 2.49, "bonus": 0.25, "you_pay": 12.25,
      "explanation": "Chemist Warehouse matches the price and takes a further 10% off the difference."
    },
    "amcal": { "status": "ask_in_store", "explanation": "Amcal has no published price match policy; individual stores may match at their discretion. Show them the competitor price." }
  },
  "summary": "...",
  "searched_at": "2026-11-11T03:00:00.000Z",
  "usage": { "input_tokens": 0, "output_tokens": 0, "web_searches": 0 }
}
```
`you_pay = competitor_price - 0.10 * (cw_price - competitor_price)`, rounded to cents, never below 0.

## lib/policy.js (deterministic)

```js
export const RETAILERS = [
  { domain: "chemistwarehouse.com.au", name: "Chemist Warehouse", kind: "pharmacy", self: true },
  { domain: "amcal.com.au",            name: "Amcal",             kind: "pharmacy" },
  { domain: "priceline.com.au",        name: "Priceline",         kind: "pharmacy" },
  { domain: "terrywhitechemmart.com.au", name: "TerryWhite Chemmart", kind: "pharmacy" },
  { domain: "mychemist.com.au",        name: "My Chemist",        kind: "pharmacy" },
  { domain: "discountdrugstores.com.au", name: "Discount Drug Stores", kind: "pharmacy" },
  { domain: "bloomsthechemist.com.au", name: "Blooms The Chemist", kind: "pharmacy" },
  { domain: "pharmacy4less.com.au",    name: "Pharmacy 4 Less",   kind: "pharmacy" },
  { domain: "goodpricepharmacy.com.au", name: "Good Price Pharmacy", kind: "pharmacy" },
  { domain: "woolworths.com.au",       name: "Woolworths",        kind: "supermarket" },
  { domain: "coles.com.au",            name: "Coles",             kind: "supermarket" },
  { domain: "aldi.com.au",             name: "ALDI",              kind: "supermarket" },
  { domain: "iga.com.au",              name: "IGA",               kind: "supermarket" },
  { domain: "kmart.com.au",            name: "Kmart",             kind: "department" },
  { domain: "bigw.com.au",             name: "Big W",             kind: "department" },
  { domain: "target.com.au",           name: "Target",            kind: "department" },
  { domain: "amazon.com.au",           name: "Amazon AU",         kind: "marketplace" },
  { domain: "ebay.com.au",             name: "eBay AU",           kind: "marketplace" },
  { domain: "catch.com.au",            name: "Catch",             kind: "online_only" },
  { domain: "iherb.com",               name: "iHerb",             kind: "overseas" },
  { domain: "chemistdirect.com.au",    name: "Chemist Direct",    kind: "online_only" },
  { domain: "pharmacyonline.com.au",   name: "Pharmacy Online",   kind: "online_only" },
];
export const RETAILER_DOMAINS = RETAILERS.map(r => r.domain);
```
- `classify(url, retailerName)` -> `{domain, name, kind}`; match by hostname suffix, fall back to a fuzzy name
  match, else `kind: "unknown"`.
- `matchability(row)` returns `{matchable, reason}`:
  - `pharmacy | supermarket | department` and `in_stock !== false` -> `"yes"`, "Australian retailer with physical stores".
  - same but `in_stock === false` -> `"no"`, "Competitor shows out of stock".
  - `marketplace` -> `"no"`, "Marketplaces are not matched".
  - `online_only` -> `"maybe"`, "Online-only retailer: Chemist Warehouse online may match, stores usually won't".
  - `overseas` -> `"no"`, "Overseas retailer".
  - `unknown` -> `"maybe"`, "Check the retailer is an Australian registered pharmacy or retailer".
  - Chemist Warehouse itself -> `"self"`.
- `CW_POLICY` text constants (used by API and shown in the UI "How it works" sheet):
  - Matches a lower advertised price from an Australian registered pharmacy or retailer on the identical product (same brand, size, variant), then takes a further 10% off the difference.
  - Product must be in stock at the competitor; clearance, bundle, loyalty-only and marketplace prices are excluded; max 3 per product.
  - In store: show the competitor's current price (website on your phone is fine). Online: contact Chemist Warehouse customer service with the product URL before ordering.
  - Policy text is a summary of published terms as at Nov 2026; confirm current terms at chemistwarehouse.com.au.
- `AMCAL_POLICY`: no published price match policy; franchise stores may match at their discretion.

## Front-end (index.html)

Single file, no framework, no build step. Mobile first (375px), works to desktop. Inter from Google Fonts.
Theme: design tokens on `:root`, dark mode via `prefers-color-scheme` with `data-theme` override.
Must reuse the `-webkit-font-smoothing: antialiased` body rule the other demos use.

Screens (all in one page, show/hide sections):
1. **PIN gate**: 4-8 digit input, stored in `localStorage` under `pm_pin` after first success (a successful
   `/api/identify` or `/api/compare` call = success). Wrong PIN -> clear and show error.
2. **Home**: big "Take a photo" button (`<input type=file accept="image/*" capture="environment">`), an "or type the
   product" text field with "Search" button, and a recent-lookups list (last 10, `localStorage` `pm_recent`).
3. **Identifying**: image preview + spinner. Client downsizes the image with a canvas to max 1280px on the long
   edge, JPEG quality 0.8, before upload.
4. **Confirm**: shows identified name / brand / size, editable text field prefilled with `search_query`, "Looks right,
   find prices" button, and "Retake". If `is_product:false`, show notes and let her type the name instead.
5. **Results**:
   - Headline card: verdict. One of: "Price match it: pay $X at Chemist Warehouse" (with competitor name and
     saving vs CW price), "Chemist Warehouse is already cheapest", or "Couldn't find a matchable price".
   - Chemist Warehouse row and Amcal row with price + link.
   - Store list sorted by price, each with retailer name, price (and was-price struck through if promo),
     matchable badge (green yes / amber maybe / grey no) and the reason, link opens in new tab.
   - "Show at the counter" button opens a full-screen sheet: product name, competitor name, competitor price,
     competitor URL as a big link + QR-less plain text, and the CW policy summary. Steph shows this to staff.
   - "Copy summary" copies a plain-text version.
   - "How price matching works" expandable with `CW_POLICY` and `AMCAL_POLICY`.
   - Disclaimer line: prices were read from retailer websites at `searched_at`; always check the live page.
6. Error states: network error, 401 (back to PIN), 429, 502 (model refused / failed) with retry.

Fetch helper: `api(path, body)` adds `x-app-pin`, `Content-Type: application/json`, 90 s timeout via AbortController.

PWA: `manifest.webmanifest` (name "Price Match", short_name "PriceMatch", display standalone, theme colour from
tokens, icons 192/512, apple-touch-icon link in head, `theme-color` meta). `sw.js` caches only `/`, `/index.html`,
`/manifest.webmanifest`, icons; network-first for everything; never touches `/api/`.

## Dev server (scripts/dev-server.mjs)

`node scripts/dev-server.mjs` on `PORT` (default 3000). Serves static files from repo root; for `/api/<name>`
dynamically imports `api/<name>.js` and calls `default(req, res)` after attaching `req.body` (parsed JSON) and
Vercel-style `res.status(n)` / `res.json(obj)` / `res.setHeader` helpers if missing. Honour `MOCK_API`, `APP_PIN` from env. Load a
`.env` file if present (simple KEY=VALUE parser; no dotenv dependency).

Handlers must work both under Vercel (where `req.body` is pre-parsed and `res.status().json()` exist) and
under the dev server. Write handlers as `export default async function handler(req, res)`.

## vercel.json

```json
{ "functions": { "api/*.js": { "maxDuration": 60 } } }
```
Static files served from root as-is; `/api/*` from functions. Set `engines.node` to `22.x` in package.json.

## Tests (node --test test/)

- policy: classify by url suffix, by name fallback, unknown; matchability table; `you_pay` maths incl. rounding and floor at 0.
- auth: PIN timing-safe compare, missing PIN, mock bypass, rate limit trips on the 31st call.
- extractJson: plain JSON, fenced JSON, JSON with leading prose, invalid -> throws.
- schemas: valid/invalid identify and compare bodies.
- handlers in MOCK_API=1: identify and compare return the documented shapes (call `default(req,res)` with fake req/res).

## Non-goals (v1)

No accounts, no database, no price history, no barcode-scanner library (Claude reads barcodes from the photo
when visible), no push notifications.

## My list (front-end)

A saved shopping list of deals for a multi-item Chemist Warehouse visit. Client-side only; no API changes.

Storage: `localStorage` key `pm_list`, array of `{ id, name, size, product, result, saved_at, done }`.
`product` is the compare request product, `result` the full `/api/compare` response at save time.
Items are identified by `product.name` + `size` (case-insensitive). Max 30 items. Writes are wrapped in
try/catch; on quota failure `result.stores` is dropped from all but the newest item and the write retried once.
Age text uses `result.searched_at` (falling back to `saved_at`); amber when older than 24 h.

Screens and controls:
- Results: "Add to my list" button (reads "On my list" when present; tapping then updates the stored result).
- Header: list icon button with count badge (hidden when empty), on every screen except the PIN gate. Home also
  shows a "My list (N)" button under recent lookups.
- `data-screen="list"`: totals bar (not-done items: sum of `you_pay` for matches plus `cw_price` for
  already-cheapest; saving is `cw_price - you_pay` over matches; hidden when nothing summable), "Refresh all"
  (confirm(), sequential, "Refreshing 2 of 5…"), cards with "Got it" (moves to a Done group), "Show" (opens the
  counter sheet; hidden without `best_matchable`), "Refresh" (single `/api/compare`, updates in place, errors
  shown inline on the card, 401 returns to the PIN gate) and "Remove"; "Clear done items" at the bottom.
- "Show whole list at the counter": full-screen sheet of every not-done matched item (competitor, price, link),
  with the Chemist Warehouse policy bullets once at the bottom. Close button and Escape close it.
