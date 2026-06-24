/**
 * DeepStream — HLS Proxy (Node.js Serverless Runtime)
 *
 * Switched from Edge runtime → Node.js runtime so Vercel uses
 * AWS Lambda IPs instead of Cloudflare-like edge IPs.
 * This fixes IPTV servers that block cloud/CDN IP ranges.
 *
 * Uses native node:http / node:https so any port (e.g. 9080) works.
 */

import http  from "node:http";
import https from "node:https";
import { URL } from "node:url";

/* ── Upstream request headers ────────────────────────────────── */
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

const REFERER_MAP = [
  { pattern: /fancode\.com/i,  referer: "https://www.fancode.com/",   origin: "https://www.fancode.com"  },
  { pattern: /jiocinema/i,     referer: "https://www.jiocinema.com/", origin: "https://www.jiocinema.com" },
  { pattern: /hotstar/i,       referer: "https://www.hotstar.com/",   origin: "https://www.hotstar.com"  },
  { pattern: /sonyliv/i,       referer: "https://www.sonyliv.com/",   origin: "https://www.sonyliv.com"  },
];

function headersForUrl(url) {
  const h = { ...BASE_HEADERS };
  for (const { pattern, referer, origin } of REFERER_MAP) {
    if (pattern.test(url)) {
      h.Referer = referer;
      h.Origin  = origin;
      return h;
    }
  }
  return h; /* No Referer for direct-IP / unknown IPTV servers */
}

/* ── URL helpers ─────────────────────────────────────────────── */
function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  try { return new URL(relative, base).href; } catch { return relative; }
}

function proxyUrl(origin, target) {
  return `${origin}/api/hls?url=${encodeURIComponent(target)}`;
}

/* ── Manifest rewriter ───────────────────────────────────────── */
function rewriteManifest(text, sourceUrl, origin) {
  const base = sourceUrl.replace(/\/[^/]*(\?.*)?$/, "/");

  let out = text
    .replace(/URI="([^"]+)"/gi, (_, u) => `URI="${proxyUrl(origin, resolveUrl(base, u))}"`)
    .replace(/URI='([^']+)'/gi, (_, u) => `URI='${proxyUrl(origin, resolveUrl(base, u))}'`);

  return out.split(/\r?\n/).map((line) => {
    const t = line.trimEnd();
    if (!t || t.startsWith("#")) return t;
    return proxyUrl(origin, resolveUrl(base, t));
  }).join("\n");
}

/* ── Manifest URL detection ──────────────────────────────────── */
function looksLikeManifest(url, contentType) {
  if (/\.(m3u8?|m3)([\?#]|$)/i.test(url)) return true;
  if (contentType && /mpegurl|m3u/i.test(contentType)) return true;
  if (/\/(video|stream|live|hls|channel|play)(\/|$)/i.test(url)) return true;
  return false;
}

/* ── CORS headers ────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
}

/* ── Main handler (Node.js req/res style) ────────────────────── */
export default function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  /* Parse target URL from query string */
  let target;
  try {
    const reqUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    target = reqUrl.searchParams.get("url");
  } catch {
    res.statusCode = 400;
    res.end("Bad request URL");
    return;
  }

  if (!target) {
    res.statusCode = 400;
    res.end("Missing url param");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.statusCode = 400;
    res.end("Invalid url param");
    return;
  }

  /* Determine proxy origin for rewriting */
  const proto  = req.headers["x-forwarded-proto"] || "https";
  const host   = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const origin = `${proto}://${host}`;

  /* Build upstream request options */
  const upstreamHeaders = headersForUrl(target);
  if (req.headers["range"]) upstreamHeaders["Range"] = req.headers["range"];

  const requestOptions = {
    hostname: targetUrl.hostname,
    port:     targetUrl.port
                ? parseInt(targetUrl.port, 10)
                : (targetUrl.protocol === "https:" ? 443 : 80),
    path:     targetUrl.pathname + targetUrl.search,
    method:   "GET",
    headers:  upstreamHeaders,
    timeout:  30000,
  };

  /* Choose http or https module */
  const transport = targetUrl.protocol === "https:" ? https : http;

  const upstreamReq = transport.request(requestOptions, (upstreamRes) => {
    const status      = upstreamRes.statusCode || 502;
    const contentType = upstreamRes.headers["content-type"] || "";

    if (status >= 400) {
      res.statusCode = status;
      res.end(`Upstream returned HTTP ${status}`);
      return;
    }

    /* ── Manifest: buffer + rewrite ── */
    if (looksLikeManifest(target, contentType)) {
      const chunks = [];
      upstreamRes.on("data", (c) => chunks.push(c));
      upstreamRes.on("end", () => {
        const text    = Buffer.concat(chunks).toString("utf-8");
        const trimmed = text.trimStart();

        if (trimmed.startsWith("#EXTM3U") || trimmed.includes("#EXTINF")) {
          const rewritten = rewriteManifest(text, target, origin);
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Cache-Control", "no-store");
          res.statusCode = 200;
          res.end(rewritten);
        } else {
          /* Not actually a manifest — pass through as binary */
          res.setHeader("Content-Type", contentType || "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          res.statusCode = 200;
          res.end(Buffer.concat(chunks));
        }
      });
      upstreamRes.on("error", (err) => {
        if (!res.headersSent) { res.statusCode = 502; res.end(err.message); }
      });
      return;
    }

    /* ── Binary passthrough (TS segments, keys) ── */
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    if (upstreamRes.headers["content-range"])  res.setHeader("Content-Range",  upstreamRes.headers["content-range"]);
    if (upstreamRes.headers["content-length"]) res.setHeader("Content-Length", upstreamRes.headers["content-length"]);
    if (upstreamRes.headers["accept-ranges"])  res.setHeader("Accept-Ranges",  upstreamRes.headers["accept-ranges"]);

    res.writeHead(status);
    upstreamRes.pipe(res);
    upstreamRes.on("error", (err) => {
      if (!res.headersSent) { res.statusCode = 502; res.end(err.message); }
    });
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy();
    if (!res.headersSent) { res.statusCode = 504; res.end("Gateway timeout"); }
  });

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) { res.statusCode = 502; res.end(`Proxy fetch failed: ${err.message}`); }
  });

  upstreamReq.end();
}
