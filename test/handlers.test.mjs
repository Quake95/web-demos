import test from "node:test";
import assert from "node:assert/strict";
import identify from "../api/identify.js";
import compare from "../api/compare.js";

process.env.MOCK_API = "1";
delete process.env.APP_PIN;

function fakeRes() {
  const res = { headers: {}, code: 200, body: undefined };
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}
const post = (body, ip) => ({ method: "POST", headers: { "x-forwarded-for": ip }, body });

test("identify (mock) returns documented shape", async () => {
  const res = fakeRes();
  await identify(post({ text: "nurofen" }, "10.0.0.1"), res);
  assert.equal(res.code, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const p = res.body.product;
  for (const k of ["is_product", "name", "brand", "size", "variant", "barcode", "search_query", "confidence", "notes"]) assert.ok(k in p, k);
  assert.equal(p.size, "96 pack");
});

test("identify rejects empty body with 400", async () => {
  const res = fakeRes();
  await identify(post({}, "10.0.0.2"), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, "invalid_request");
});

test("compare (mock) returns documented shape and runs policy", async () => {
  const res = fakeRes();
  await compare(post({ product: { name: "Nurofen Zavance 256mg Tablets", size: "96 pack" } }, "10.0.0.3"), res);
  assert.equal(res.code, 200);
  const b = res.body;
  for (const k of ["product", "stores", "chemist_warehouse", "amcal", "best_matchable", "match", "summary", "searched_at", "usage"]) assert.ok(k in b, k);
  assert.equal(b.match.chemist_warehouse.status, "match");
  assert.equal(b.match.chemist_warehouse.you_pay, 12.25);
  assert.equal(b.best_matchable.retailer, "Woolworths");
  assert.deepEqual(Object.keys(b.usage), ["input_tokens", "cached_input_tokens", "output_tokens", "web_searches"]);
  assert.ok(!Number.isNaN(Date.parse(b.searched_at)));
  const s = b.stores.find((x) => x.retailer === "Woolworths");
  for (const k of ["domain", "url", "price", "was_price", "promo", "in_stock", "notes", "kind", "matchable", "matchable_reason"]) assert.ok(k in s, k);
});

test("compare rejects missing product", async () => {
  const res = fakeRes();
  await compare(post({}, "10.0.0.4"), res);
  assert.equal(res.code, 400);
});
