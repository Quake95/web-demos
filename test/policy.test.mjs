import test from "node:test";
import assert from "node:assert/strict";
import { buildComparison, classify, computeYouPay, matchability, RETAILER_DOMAINS } from "../lib/policy.js";
import { mockModelCompare } from "../lib/mock.js";

test("classify by url suffix, including subdomains and www", () => {
  assert.equal(classify("https://www.woolworths.com.au/shop/x", "whatever").kind, "supermarket");
  assert.equal(classify("https://au.iherb.com/pr/x", "").kind, "overseas");
  assert.equal(classify("https://www.chemistwarehouse.com.au/buy/1", "").self, true);
  assert.equal(classify("https://notamazon.com.au/x", "").kind, "unknown");
});

test("classify falls back to retailer name", () => {
  assert.equal(classify("", "Priceline Pharmacy").name, "Priceline");
  assert.equal(classify("not a url", "amcal").kind, "pharmacy");
});

test("classify returns unknown for unrecognised retailers", () => {
  const c = classify("https://random-shop.example/p", "Random Shop");
  assert.equal(c.kind, "unknown");
  assert.equal(c.name, "Random Shop");
});

test("matchability table", () => {
  const m = (kind, extra = {}) => matchability({ kind, ...extra }).matchable;
  assert.equal(m("pharmacy"), "yes");
  assert.equal(m("supermarket", { in_stock: null }), "yes");
  assert.equal(m("department", { in_stock: true }), "yes");
  assert.equal(m("pharmacy", { in_stock: false }), "no");
  assert.equal(m("marketplace"), "no");
  assert.equal(m("online_only"), "maybe");
  assert.equal(m("overseas"), "no");
  assert.equal(m("unknown"), "maybe");
  assert.equal(m("pharmacy", { self: true }), "self");
});

test("computeYouPay maths and rounding", () => {
  assert.deepEqual(computeYouPay(14.99, 12.5), { difference: 2.49, bonus: 0.25, you_pay: 12.25 });
  assert.deepEqual(computeYouPay(10.33, 9.99), { difference: 0.34, bonus: 0.03, you_pay: 9.96 }); // 9.956 rounds to 9.96
});

test("computeYouPay floors at 0", () => {
  assert.equal(computeYouPay(100, 0).you_pay, 0);
  assert.equal(computeYouPay(5, 0.2).you_pay >= 0, true);
});

test("buildComparison over mock data", () => {
  const r = buildComparison({ name: "x" }, mockModelCompare());
  assert.equal(r.stores.length, 8);
  assert.equal(r.chemist_warehouse.price, 14.99);
  assert.equal(r.amcal.price, 16.49);
  assert.equal(r.best_matchable.retailer, "Woolworths");
  assert.equal(r.match.chemist_warehouse.status, "match");
  assert.equal(r.match.chemist_warehouse.you_pay, 12.25);
  assert.equal(r.match.amcal.status, "ask_in_store");
  const by = Object.fromEntries(r.stores.map((s) => [s.retailer, s.matchable]));
  assert.equal(by["Chemist Warehouse"], "self");
  assert.equal(by["Amazon AU"], "no");
  assert.equal(by["iHerb"], "no");
  assert.equal(by["Coles"], "yes");
  assert.equal(by["Big W"], "no"); // exact:false row is cheapest but must never win the match
  assert.equal(r.best_matchable.price, 12.5);
  assert.ok(r.stores.every((s, i, a) => i === 0 || a[i - 1].price <= s.price));
});

test("buildComparison: implausibly low competitor price is flagged, not matched", () => {
  const row = (retailer, url, price, extra = {}) => ({ retailer, url, price, was_price: null, promo: false, in_stock: true, notes: "", ...extra });
  const r = buildComparison({}, { stores: [
    row("Chemist Warehouse", "https://chemistwarehouse.com.au/a", 38.49),
    row("Amcal", "https://amcal.com.au/a", 2),
    row("Priceline", "https://priceline.com.au/a", 35),
    row("Coles", "https://coles.com.au/a", 0.1),
  ] });
  const amcal = r.stores.find((s) => s.retailer === "Amcal");
  assert.equal(amcal.matchable, "maybe");
  assert.equal(r.best_matchable.retailer, "Priceline");
  assert.equal(r.match.chemist_warehouse.status, "match");
  assert.ok(!r.stores.some((s) => s.retailer === "Coles"), "sub-50c rows are dropped");
});

test("buildComparison: already_cheapest and unknown", () => {
  const row = (retailer, url, price, extra = {}) => ({ retailer, url, price, was_price: null, promo: false, in_stock: true, notes: "", ...extra });
  const cheap = buildComparison({}, { stores: [row("Chemist Warehouse", "https://chemistwarehouse.com.au/a", 9), row("Coles", "https://coles.com.au/a", 10)] });
  assert.equal(cheap.match.chemist_warehouse.status, "already_cheapest");
  const noCw = buildComparison({}, { stores: [row("Coles", "https://coles.com.au/a", 10)] });
  assert.equal(noCw.match.chemist_warehouse.status, "unknown");
  // a Chemist Warehouse row for a different pack size is not Chemist Warehouse's price
  const inexactCw = buildComparison({}, { stores: [row("Chemist Warehouse", "https://chemistwarehouse.com.au/b", 20, { exact: false }), row("Coles", "https://coles.com.au/a", 10)] });
  assert.equal(inexactCw.chemist_warehouse, null);
  assert.equal(inexactCw.match.chemist_warehouse.status, "unknown");
  const none = buildComparison({}, { stores: [row("Amazon AU", "https://amazon.com.au/a", 5)] });
  assert.equal(none.best_matchable, null);
  assert.equal(none.match.chemist_warehouse.status, "unknown");
});

test("out-of-stock competitor is never best_matchable; bad prices dropped", () => {
  const row = (retailer, url, price, in_stock) => ({ retailer, url, price, was_price: null, promo: false, in_stock, notes: "" });
  const r = buildComparison({}, { stores: [row("Coles", "https://coles.com.au/a", 1, false), row("Woolworths", "https://woolworths.com.au/a", 0, true), row("Chemist Warehouse", "https://chemistwarehouse.com.au/a", 5, true)] });
  assert.equal(r.best_matchable, null);
  assert.equal(r.stores.length, 2);
});

test("RETAILER_DOMAINS exports domains", () => {
  assert.ok(RETAILER_DOMAINS.includes("chemistwarehouse.com.au"));
});
