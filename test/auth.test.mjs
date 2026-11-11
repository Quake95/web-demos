import test from "node:test";
import assert from "node:assert/strict";
import { checkPin, createRateLimiter, guard } from "../lib/auth.js";

function fakeRes() {
  const res = { headers: {}, code: 200, body: undefined };
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}
const req = (over = {}) => ({ method: "POST", headers: { "x-app-pin": "1234", "x-forwarded-for": "9.9.9.9, 1.1.1.1" }, body: { a: 1 }, ...over });
const opts = (env) => ({ env, limiter: createRateLimiter() });

test("checkPin compares correctly", () => {
  assert.equal(checkPin("1234", "1234"), true);
  assert.equal(checkPin("1235", "1234"), false);
  assert.equal(checkPin("123", "1234"), false);
  assert.equal(checkPin(undefined, "1234"), false);
  assert.equal(checkPin("", ""), false);
});

test("missing or wrong PIN -> 401", () => {
  for (const headers of [{}, { "x-app-pin": "0000" }]) {
    const res = fakeRes();
    assert.equal(guard(req({ headers }), res, opts({ APP_PIN: "1234" })), false);
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { error: "bad_pin" });
  }
});

test("correct PIN passes and sets no-store", () => {
  const res = fakeRes();
  assert.equal(guard(req(), res, opts({ APP_PIN: "1234" })), true);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("APP_PIN unset: 503 unless MOCK_API=1", () => {
  const res = fakeRes();
  assert.equal(guard(req(), res, opts({})), false);
  assert.equal(res.code, 503);
  const res2 = fakeRes();
  assert.equal(guard(req({ headers: {} }), res2, opts({ MOCK_API: "1" })), true);
});

test("non-POST -> 405; bad body -> 400", () => {
  const res = fakeRes();
  assert.equal(guard(req({ method: "GET" }), res, opts({ APP_PIN: "1234" })), false);
  assert.equal(res.code, 405);
  const res2 = fakeRes();
  assert.equal(guard(req({ body: undefined }), res2, opts({ APP_PIN: "1234" })), false);
  assert.equal(res2.code, 400);
});

test("rate limit trips on the 31st call", () => {
  const o = opts({ APP_PIN: "1234" });
  for (let i = 1; i <= 30; i++) assert.equal(guard(req(), fakeRes(), o), true, `call ${i}`);
  const res = fakeRes();
  assert.equal(guard(req(), res, o), false);
  assert.equal(res.code, 429);
  assert.deepEqual(res.body, { error: "rate_limited" });
});

test("rate limit window expires", () => {
  let t = 0;
  const l = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.ok(l.hit("a") && l.hit("a"));
  assert.equal(l.hit("a"), false);
  t = 1001;
  assert.equal(l.hit("a"), true);
});
