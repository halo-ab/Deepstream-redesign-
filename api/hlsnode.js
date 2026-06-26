/**
 * DeepStream — HLS Proxy for IPTV / Direct-IP streams
 * Uses Node.js Serverless Runtime with native http module.
 *
 * Classic (req, res) handler — maximum compatibility with Vercel Node.js runtime.
 * Uses node:http for outgoing requests — works with any port (9080, 8080, etc.)
 */

import http  from "node:http";
import https from "node:https";
import { URL } from "node:url";

/* ── Keep-alive agents — reuse TCP connections across requests ── */
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 20, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30000 });

/* ── Upstream headers ────────────────────────────────────────── */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ── URL helpers ─────────────────────────────────────────────── */
function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  try { return new URL(relative, base).href; } catch { return relative; }
}

function makeProxyUrl(origin, target, customParams) {
  let u = `${origin}/api/hlsnode?url=${encodeURIComponent(target)}`;
  if (customParams) u += customParams;
  return u;
}

/* ── Manifest rewriter ───────────────────────────────────────── */
function rewriteManifest(text, sourceUrl, proxyOrigin, customParams) {
  const base = sourceUrl.replace(/\/[^/]*(\?.*)?$/, "/");

  let out = text
    .replace(/URI="([^"]+)"/gi, (_, u) => `URI="${makeProxyUrl(proxyOrigin, resolveUrl(base, u), customParams)}"`)
    .replace(/URI='([^']+)'/gi, (_, u) => `URI='${makeProxyUrl(proxyOrigin, resolveUrl(base, u), customParams)}'`);

  return out.split(/\r?\n/).map((line) => {
    const t = line.trimEnd();
    if (!t || t.startsWith("#")) return t;
    return makeProxyUrl(proxyOrigin, resolveUrl(base, t), customParams);
  }).join("\n");
}

/* ── Manifest detection ──────────────────────────────────────── */
function looksLikeManifest(url, ct) {
  if (/\.(m3u8?|m3)([\?#]|$)/i.test(url)) return true;
  if (ct && /mpegurl|m3u/i.test(ct)) return true;
  if (/\/(video|stream|live|hls|channel|play)(\/|\.m3|$)/i.test(url)) return true;
  return false;
}

/* ── Set CORS on response ────────────────────────────────────── */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
}

/* ── Fetch upstream using native http/https ───────────────────
   Returns a Promise that resolves with the IncomingMessage.     */
function fetchUpstream(targetUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      agent:    parsed.protocol === "https:" ? httpsAgent : httpAgent,
      headers:  {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Connection: "keep-alive",
        ...extraHeaders,
      },
      timeout:  25000,
    };

    const req = transport.request(opts, (res) => resolve(res));
    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.on("error",   (e) => reject(e));
    req.end();
  });
}

/* ── Buffer a readable stream ─────────────────────────────────── */
function bufferStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end",  ()  => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/* ── Main handler (classic Node.js req, res) ──────────────────── */
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  /* Parse target from ?url= */
  let target, customUA, customReferer;
  try {
    const u = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    target        = u.searchParams.get("url");
    customUA      = u.searchParams.get("ua");
    customReferer = u.searchParams.get("referer");
  } catch {
    res.statusCode = 400;
    return res.end("Bad request");
  }

  if (!target) {
    res.statusCode = 400;
    return res.end("Missing url param");
  }

  /* Build suffix to preserve custom headers in rewritten URLs */
  let customParams = "";
  if (customUA)      customParams += `&ua=${encodeURIComponent(customUA)}`;
  if (customReferer) customParams += `&referer=${encodeURIComponent(customReferer)}`;

  /* Compute proxy origin for URL rewriting */
  const proto  = req.headers["x-forwarded-proto"] || "https";
  const host   = req.headers["x-forwarded-host"]  || req.headers.host || "localhost";
  const origin = `${proto}://${host}`;

  /* Extra headers (forward Range if present, plus custom UA/Referer) */
  const extra = {};
  if (req.headers.range) extra.Range = req.headers.range;
  if (customUA) extra["User-Agent"] = customUA;
  if (customReferer) { extra.Referer = customReferer; extra.Origin = customReferer.replace(/\/$/, ""); }

  let upstream;
  try {
    upstream = await fetchUpstream(target, extra);
  } catch (err) {
    res.statusCode = 502;
    return res.end(`Proxy error: ${err.message}`);
  }

  const status = upstream.statusCode || 502;

  /* Handle redirects manually (301, 302, 307, 308) */
  if ([301, 302, 307, 308].includes(status) && upstream.headers.location) {
    const redirectUrl = resolveUrl(target, upstream.headers.location);
    try {
      upstream = await fetchUpstream(redirectUrl, extra);
    } catch (err) {
      res.statusCode = 502;
      return res.end(`Redirect failed: ${err.message}`);
    }
  }

  if (status >= 400) {
    res.statusCode = status;
    return res.end(`Upstream HTTP ${status}`);
  }

  const ct = upstream.headers["content-type"] || "";

  /* ── Manifest path: buffer, detect, rewrite ── */
  if (looksLikeManifest(target, ct)) {
    const buf  = await bufferStream(upstream);
    const text = buf.toString("utf-8");
    const trimmed = text.trimStart();

    if (trimmed.startsWith("#EXTM3U") || trimmed.includes("#EXTINF")) {
      const rewritten = rewriteManifest(text, target, origin, customParams);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      res.statusCode = 200;
      return res.end(rewritten);
    }

    /* Not a manifest after all — send raw */
    res.setHeader("Content-Type", ct || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 200;
    return res.end(buf);
  }

  /* ── Binary passthrough (TS segments, keys) ── */
  res.setHeader("Content-Type", ct || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  if (upstream.headers["content-range"])  res.setHeader("Content-Range",  upstream.headers["content-range"]);
  if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
  if (upstream.headers["accept-ranges"])  res.setHeader("Accept-Ranges",  upstream.headers["accept-ranges"]);

  res.statusCode = status;
  upstream.pipe(res);
}
