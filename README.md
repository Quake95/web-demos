# Price Match Helper

Snap a photo of a product (or type its name), find cheaper prices at Australian retailers, and
see whether Chemist Warehouse should price match it. Built for one person's phone, hosted on Vercel.

How it works:

1. **Identify.** The photo goes to Claude, which reads the brand, size and variant and returns a clean search query. You can correct it before searching.
2. **Compare.** Claude's built-in web search looks up that exact product on Australian retailer sites (Chemist Warehouse, Amcal, Priceline, TerryWhite, Woolworths, Coles, Kmart, Big W, Amazon AU and others) and reads the advertised prices.
3. **Verdict.** The app applies Chemist Warehouse's published match rules (Australian pharmacy or retailer, identical product, in stock, no marketplaces or clearance) and tells you what you would pay after the match plus the extra 10% off the difference. A "Show at the counter" sheet puts the competitor price and link on one big screen for staff.

Amcal has no published price match policy. The app still shows Amcal's price and suggests asking in store.

## Project layout

```
index.html               the app (PWA, no build step)
manifest.webmanifest     install metadata
sw.js                    service worker (static shell only)
api/identify.js          POST photo or text -> product identity
api/compare.js           POST product -> prices and match verdict
lib/                     policy rules, auth, schemas, Anthropic client, mock data
scripts/dev-server.mjs   local server that mounts api/ like Vercel does
test/                    node:test unit tests
docs/SPEC.md             build spec
tradie/, accountant/     older demo pages, unrelated
```

## Deploy to Vercel

1. vercel.com -> Add New Project -> import `Quake95/web-demos`. Framework preset: Other. No build command, output directory blank.
2. Settings -> Environment Variables (Production):
   - `ANTHROPIC_API_KEY` from console.anthropic.com
   - `APP_PIN` a 4-8 digit PIN only you and Steph know
   - optional `CLAUDE_MODEL` (default `claude-opus-5-5`), `MAX_SEARCHES` (default 10)
3. Deploy. Open the URL on the phone, enter the PIN once, then use the browser's "Add to Home Screen".

Only requests carrying the right PIN reach the API, and the functions rate limit per IP, so a leaked URL cannot spend your credit.

## Cost

Each lookup is one vision call plus one web search call. A real lookup measured about 60k input tokens, 1.6k output tokens and 8 web searches, which is roughly 35 cents at current Claude Opus 5.5 and web search pricing. Setting `CLAUDE_MODEL=claude-sonnet-5-5` roughly halves that. Lower `MAX_SEARCHES` to cap it.

## Status

Unit tests and the full phone flow pass in mock mode. The live Claude calls (photo identification and the web search price research) were not exercised in the build environment because it has no API key, so the first real lookup after deploying is the live test. If it fails, the error screen names the cause (missing key, model refused, upstream error) and the function logs in Vercel show the detail.

## Local development

```bash
npm install
cp .env.example .env      # add your key and PIN
npm run dev               # http://localhost:3000
npm run dev:mock          # no API calls, canned data, PIN 1234
npm test
```

## Price match rules used

Summary of Chemist Warehouse's published terms as at November 2026. Confirm the current terms at chemistwarehouse.com.au before relying on them.

- Matches a lower advertised price from an Australian registered pharmacy or retailer on the identical product (brand, size, variant), then takes a further 10% off the difference.
- The product must be in stock at the competitor. Clearance, bundle, loyalty-only and marketplace prices are excluded. Maximum three per product.
- In store, show the competitor's current price on your phone. Online, contact Chemist Warehouse customer service with the product URL before ordering.
