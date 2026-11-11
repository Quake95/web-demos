// PIN check, in-memory rate limit, and JSON error helpers shared by the API handlers.
import crypto from "node:crypto";

export const MAX_BODY_BYTES = 6 * 1024 * 1024;

/** Error carrying an HTTP status and machine-readable code. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** Send `{error, message?}` as JSON. */
export function fail(res, status, error, message) {
  res.status(status).json(message ? { error, message } : { error });
}

/**
 * Constant-time PIN comparison. Both values are hashed first so lengths always match.
 * @param {unknown} provided
 * @param {unknown} expected
 */
export function checkPin(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sliding-window in-memory rate limiter. Best effort: resets on cold start.
 * @param {{limit?: number, windowMs?: number, now?: () => number}} [opts]
 */
export function createRateLimiter({ limit = 30, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    /** Record a request; returns false when the caller is over the limit. */
    hit(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}

export const defaultLimiter = createRateLimiter();

/** First address in x-forwarded-for, else the socket address. */
export function clientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  const first = String(Array.isArray(xff) ? xff[0] : xff ?? "").split(",")[0].trim();
  return first || req.socket?.remoteAddress || "unknown";
}

function parseBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  return body;
}

/**
 * Common gate for every API handler: method, config, rate limit, PIN, JSON body.
 * Sends the error response itself. On success sets `req.body` to the parsed object.
 * @param {import("http").IncomingMessage & {body?: any}} req
 * @param {any} res
 * @param {{env?: object, limiter?: ReturnType<typeof createRateLimiter>}} [opts]
 * @returns {boolean} true when the handler may continue
 */
export function guard(req, res, { env = process.env, limiter = defaultLimiter } = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    fail(res, 405, "method_not_allowed");
    return false;
  }
  const mock = env.MOCK_API === "1";
  const pin = env.APP_PIN;
  if (!pin && !mock) {
    fail(res, 503, "not_configured");
    return false;
  }
  if (!limiter.hit(clientIp(req))) {
    fail(res, 429, "rate_limited");
    return false;
  }
  if (pin && !checkPin(req.headers?.["x-app-pin"], pin)) {
    fail(res, 401, "bad_pin");
    return false;
  }
  if (Number(req.headers?.["content-length"]) > MAX_BODY_BYTES) {
    fail(res, 413, "payload_too_large");
    return false;
  }
  const body = parseBody(req.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail(res, 400, "invalid_body", "Body must be a JSON object");
    return false;
  }
  req.body = body;
  return true;
}
