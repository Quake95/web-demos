// Local server: static files from the repo root + /api/<name> mounted with Vercel's (req, res) signature.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 6 * 1024 * 1024;
const PRIVATE = new Set(["node_modules", "lib", "scripts", "test", "docs", "api", "package.json", "package-lock.json", "vercel.json"]);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
};

/** Load KEY=VALUE lines from .env into process.env without overriding existing vars. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    process.env[m[1]] ??= m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

/** Add Vercel-style helpers to Node's ServerResponse. */
function addHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
}

function sendJson(res, status, obj) {
  res.status(status).json(obj);
}

/** Read the request body (up to 6 MB) and JSON-parse it. Resolves `undefined` for empty bodies. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413, code: "payload_too_large" }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("bad json"), { status: 400, code: "invalid_json" }));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, name) {
  const file = path.join(ROOT, "api", `${name}.js`);
  if (!/^[a-z0-9-]+$/i.test(name) || !fs.existsSync(file)) return sendJson(res, 404, { error: "not_found" });
  try {
    if (req.method === "POST") req.body = await readJson(req);
    const mod = await import(pathToFileURL(file).href);
    await mod.default(req, res);
  } catch (err) {
    if (err.status) return sendJson(res, err.status, { error: err.code });
    console.error("[dev] handler crashed:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const abs = path.resolve(ROOT, rel);
  const first = path.relative(ROOT, abs).split(path.sep)[0];
  const blocked = !abs.startsWith(ROOT + path.sep) || first.startsWith(".") || PRIVATE.has(first);
  if (blocked || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJson(res, 404, { error: "not_found" });
  res.setHeader("Content-Type", TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(abs).pipe(res);
}

loadEnv(path.join(ROOT, ".env"));

const server = http.createServer(async (req, res) => {
  addHelpers(res);
  const { pathname } = new URL(req.url, "http://localhost");
  const api = pathname.match(/^\/api\/([^/]+?)\/?$/);
  if (api) return handleApi(req, res, api[1]);
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });
  try {
    serveStatic(req, res, pathname);
  } catch {
    sendJson(res, 400, { error: "bad_request" });
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  const mode = process.env.MOCK_API === "1" ? "MOCK_API" : "live API";
  console.log(`Price Match dev server on http://localhost:${port} (${mode})`);
});
