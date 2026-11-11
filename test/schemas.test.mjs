import test from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../lib/anthropic.js";
import { CompareRequest, IdentifyRequest, ModelCompareOutput, normaliseModelCompare, parseImageDataUrl } from "../lib/schemas.js";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

test("extractJson: plain, fenced, leading prose", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps'), { a: 1 });
});

test("extractJson throws on invalid", () => {
  assert.throws(() => extractJson("no json here"));
  assert.throws(() => extractJson("{not json}"));
  assert.throws(() => extractJson(""));
});

test("parseImageDataUrl", () => {
  assert.deepEqual(parseImageDataUrl(IMG), { media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" });
  assert.equal(parseImageDataUrl("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(parseImageDataUrl("data:image/png;base64,"), null);
  assert.equal(parseImageDataUrl("https://x/y.jpg"), null);
  assert.equal(parseImageDataUrl("data:image/png;base64," + "A".repeat(4 * 1024 * 1024 + 4)), null);
});

test("IdentifyRequest", () => {
  assert.ok(IdentifyRequest.safeParse({ image: IMG }).success);
  assert.ok(IdentifyRequest.safeParse({ text: "panadol" }).success);
  assert.ok(IdentifyRequest.safeParse({ image: IMG, text: "hint" }).success);
  assert.equal(IdentifyRequest.safeParse({}).success, false);
  assert.equal(IdentifyRequest.safeParse({ image: "nope" }).success, false);
  assert.equal(IdentifyRequest.safeParse({ text: "   " }).success, false);
});

test("CompareRequest", () => {
  assert.ok(CompareRequest.safeParse({ product: { name: "Nurofen", brand: null } }).success);
  assert.equal(CompareRequest.safeParse({ product: { name: "" } }).success, false);
  assert.equal(CompareRequest.safeParse({}).success, false);
});

test("ModelCompareOutput with normalisation", () => {
  const raw = { stores: [{ retailer: "Coles", price: 5 }] };
  assert.equal(ModelCompareOutput.safeParse(raw).success, false);
  const ok = ModelCompareOutput.safeParse(normaliseModelCompare(raw));
  assert.ok(ok.success);
  assert.equal(ok.data.stores[0].in_stock, null);
  // numeric strings are parsed; non-numeric ones still fail validation
  assert.equal(ModelCompareOutput.safeParse(normaliseModelCompare({ stores: [{ retailer: "x", url: "", price: "5" }] })).data.stores[0].price, 5);
  assert.equal(ModelCompareOutput.safeParse(normaliseModelCompare({ stores: [{ retailer: "x", url: "", price: "unknown" }] })).success, false);
});

test("normaliseModelCompare parses string prices like \"$26.99\"", () => {
  const out = normaliseModelCompare({ stores: [{ retailer: "Priceline", url: "https://priceline.com.au/x", price: "$26.99", was_price: "RRP $33.99" }], summary: "" });
  assert.equal(out.stores[0].price, 26.99);
  assert.equal(out.stores[0].was_price, 33.99);
  assert.ok(ModelCompareOutput.safeParse(out).success);
});
