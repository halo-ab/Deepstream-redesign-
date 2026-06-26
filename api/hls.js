export const config = { runtime: "edge" };

/**
 * DeepStream — Universal HLS Proxy (Edge Function)
 *
 * - Detects manifests by CONTENT not just extension (.m3, .m3u8, no-ext all work)
 * - Rewrites all segment/key URLs through this proxy (CORS-safe)
 * - Smart Referer spoofing per domain; bare IP servers get no Referer
 */

/* ── Upstream headers ────────────────────────────────────────── */
const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const REFERER_MAP = [
  { pattern: /fancode\.com/i,  referer: "https://www.fancode.com/",   origin: "https://www.fancode.com"   },
  { pattern: /jiocinema/i,     referer: "https://www.jiocinema.com/", origin: "https://www.jiocinema.com"  },
  { pattern: /hotstar/i,       referer: "https://www.hotstar.com/",   origin: "https://www.hotstar.com"   },
  { pattern: /sonyliv/i,       referer: "https://www.sonyliv.com/",   origin: "https://www.sonyliv.com"   },
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

function proxyUrl(origin, target, customParams) {
  let u = `${origin}/api/hls?url=${encodeURIComponent(target)}`;
  if (customParams) u += customParams;
  return u;
}

/* ── Manifest rewriter ───────────────────────────────────────── */
function rewriteManifest(text, sourceUrl, proxyOrigin, customParams) {
  const base = sourceUrl.replace(/\/[^/]*(\?.*)?$/, "/");

  let out = text
    .replace(/URI="([^"]+)"/gi, (_, u) => `URI="${proxyUrl(proxyOrigin, resolveUrl(base, u), customParams)}"`)
    .replace(/URI='([^']+)'/gi, (_, u) => `URI='${proxyUrl(proxyOrigin, resolveUrl(base, u), customParams)}'`);

  return out.split(/\r?\n/).map((line) => {
    const t = line.trimEnd();
    if (!t || t.startsWith("#")) return t;
    return proxyUrl(proxyOrigin, resolveUrl(base, t), customParams);
  }).join("\n");
}

/* ── Manifest detection (by content + URL hints) ─────────────── */
function looksLikeManifest(url, contentType) {
  if (/\.(m3u8?|m3)([\?#]|$)/i.test(url)) return true;
  if (/\.mpd([\?#]|$)/i.test(url)) return true;
  if (contentType && /mpegurl|m3u|dash\+xml/i.test(contentType)) return true;
  if (/\/(video|stream|live|hls|channel|play)(\/|\.m3|$)/i.test(url)) return true;
  return false;
}

function isDashManifest(url, contentType) {
  if (/\.mpd([\?#]|$)/i.test(url)) return true;
  if (contentType && /dash\+xml/i.test(contentType)) return true;
  return false;
}

/* ── CORS headers ────────────────────────────────────────────── */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
}

/* ── Main handler ────────────────────────────────────────────── */
export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url param", { status: 400, headers: corsHeaders() });
  }

  /* Read custom headers from query params */
  const customUA      = reqUrl.searchParams.get("ua");
  const customReferer = reqUrl.searchParams.get("referer");

  /* Build a suffix to preserve custom headers in rewritten URLs */
  let customParams = "";
  if (customUA)      customParams += `&ua=${encodeURIComponent(customUA)}`;
  if (customReferer) customParams += `&referer=${encodeURIComponent(customReferer)}`;

  const upstreamHeaders = headersForUrl(target);
  /* Custom headers override auto-detected ones */
  if (customUA)      upstreamHeaders["User-Agent"] = customUA;
  if (customReferer) { upstreamHeaders.Referer = customReferer; upstreamHeaders.Origin = customReferer.replace(/\/$/, ""); }
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  let upstream;
  try {
    upstream = await fetch(target, { headers: upstreamHeaders, redirect: "follow" });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, { status: 502, headers: corsHeaders() });
  }

  if (!upstream.ok) {
    return new Response(`Upstream returned HTTP ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(),
    });
  }

  const proxyOrigin = reqUrl.origin;
  const contentType = upstream.headers.get("content-type") || "";

  /* ── Try manifest path ── */
  if (looksLikeManifest(target, contentType)) {
    const text    = await upstream.text();
    const trimmed = text.trimStart();

    /* DASH/MPD — pass through as-is with CORS (dash.js rewrites URLs client-side) */
    if (isDashManifest(target, contentType) || trimmed.startsWith("<?xml") || trimmed.startsWith("<MPD")) {
      return new Response(text, {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": contentType || "application/dash+xml",
          "Cache-Control": "no-store",
        },
      });
    }

    /* HLS — rewrite segment URLs through proxy */
    if (trimmed.startsWith("#EXTM3U") || trimmed.includes("#EXTINF")) {
      return new Response(rewriteManifest(text, target, proxyOrigin, customParams), {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  /* ── Binary passthrough (TS segments, keys) ── */
  const respHeaders = {
    ...corsHeaders(),
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": "no-store",
  };

  const contentRange  = upstream.headers.get("content-range");
  const contentLength = upstream.headers.get("content-length");
  const acceptRanges  = upstream.headers.get("accept-ranges");
  if (contentRange)  respHeaders["Content-Range"]  = contentRange;
  if (contentLength) respHeaders["Content-Length"] = contentLength;
  if (acceptRanges)  respHeaders["Accept-Ranges"]  = acceptRanges;

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
