// Anthropic SDK client, model/tool constants, and response helpers.
import Anthropic from "@anthropic-ai/sdk";
import { HttpError, fail } from "./auth.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const REPAIR_MODEL = "claude-haiku-5-5";
export const MAX_CONTINUATIONS = 4;

/** Model for identify/compare; override with CLAUDE_MODEL. */
export function getModel() {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

let client;
/** Lazily created SDK client (reads ANTHROPIC_API_KEY itself). */
export function getClient() {
  client ??= new Anthropic();
  return client;
}

/** web_search `max_uses` from MAX_SEARCHES (default 10, clamped 1-20). */
export function getMaxSearches() {
  const n = Math.floor(Number(process.env.MAX_SEARCHES));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 10;
}

/** Server tools for the compare request. */
export function buildCompareTools(domains, maxSearches = getMaxSearches()) {
  return [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: maxSearches,
      user_location: { type: "approximate", country: "AU" },
      allowed_domains: domains,
    },
    // Retailer pages are huge; cap what each fetch feeds back into context.
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, allowed_domains: domains, max_content_tokens: 6000 },
  ];
}

/**
 * Pull a JSON object out of model text: strips code fences, takes first "{" to last "}".
 * @param {string} text
 * @returns {any}
 * @throws {Error} when no parseable object is present
 */
export function extractJson(text) {
  const stripped = String(text ?? "").replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

/** All text from `text` blocks in a response content array. */
export function textBlocks(content) {
  return (Array.isArray(content) ? content : []).filter((b) => b?.type === "text").map((b) => b.text);
}

/** Number of web searches billed on a response (0 if absent). */
export function webSearchCount(usage) {
  return usage?.server_tool_use?.web_search_requests ?? 0;
}

/**
 * Call messages.create, continuing on `pause_turn` (up to MAX_CONTINUATIONS times, same params).
 * Prompt caching is on so each continuation re-reads the earlier turns from cache instead of paying full price.
 * @returns {Promise<{response: any, usage: {input_tokens: number, cached_input_tokens: number, output_tokens: number, web_searches: number}}>}
 */
export async function createWithContinuations(c, params) {
  const messages = [...params.messages];
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let response;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    response = await c.messages.create({ ...params, messages, cache_control: { type: "ephemeral" } });
    usage.input_tokens += (response.usage?.input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0);
    usage.cached_input_tokens += response.usage?.cache_read_input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;
    usage.web_searches += webSearchCount(response.usage);
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  return { response, usage };
}

/** Map any thrown error to `{status, body}` without leaking stacks or keys. */
export function toHttpError(err) {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.code } };
  if (err instanceof Anthropic.AuthenticationError) return { status: 500, body: { error: "server_misconfigured" } };
  if (err instanceof Anthropic.RateLimitError) return { status: 503, body: { error: "upstream_busy" } };
  if (err instanceof Anthropic.APIError) return { status: 502, body: { error: "upstream_error", message: err.message } };
  return { status: 500, body: { error: "internal" } };
}

/** Log and send the JSON error for a caught exception. */
export function sendError(res, err) {
  console.error("[api] error:", err?.name, err?.message);
  const { status, body } = toHttpError(err);
  fail(res, status, body.error, body.message);
}
