export const config = { runtime: "edge" };

/**
 * DeepStream — Universal HLS Proxy (Edge Function)
 * Handles any M3U8/HLS stream regardless of extension or origin.
 * Rewrites all manifest URLs so segments flow through this proxy (CORS-safe).
 */

/* ── Default upstream headers ────────────────────────────────────
   These work for FanCode and most IPTV servers.
   The Referer/Origin spoof helps bypass hotlink protection.      */
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* Per-domain referer spoofing — add entries as needed */
const REFERER_MAP = [
  { pattern: /fancode\.com/i,  referer: "https://www.fancode.com/",   origin: "https://www.fancode.com"  },
  { pattern: /jiocinema/i,     referer: "https://www.jiocinema.com/", origin: "https://www.jiocinema.com" },
  { pattern: /hotstar/i,       referer: "https://www.hotstar.com/",   origin: "https://www.hotstar.com"  },
  { pattern: /sonyliv/i,       referer: "https://www.sonyliv.com/",   origin: "https://www.sonyliv.com"  },
];

function headersForUrl(url) {
  const headers = { ...BASE_HEADERS };
  for (const { pattern, referer, origin } of REFERER_MAP) {
    if (pattern.test(url)) {
      headers.Referer = referer;
      headers.Origin  = origin;
      return headers;
    }
  }
  /* For direct IP / unknown IPTV servers: no Referer (avoids rejection) */
  return headers;
}

/* ── URL helpers ─────────────────────────────────────────────── */
function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  const baseDir = base.endsWith("/") ? base : base.replace(/\/[^/]*$/, "/");
  return new URL(relative, baseDir).href;
}

function proxyUrl(proxyOrigin, target) {
  return `${proxyOrigin}/api/hls?url=${encodeURIComponent(target)}`;
}

/* ── Manifest rewriter ───────────────────────────────────────── */
function rewriteManifest(text, sourceUrl, proxyOrigin) {
  const base = sourceUrl.endsWith("/") ? sourceUrl : sourceUrl.replace(/\/[^/]*$/, "/");

  /* Rewrite URI="..." attributes (encryption keys, etc.) */
  let out = text.replace(/URI="([^"]+)"/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    return `URI="${proxyUrl(proxyOrigin, resolved)}"`;
  });
  out = out.replace(/URI='([^']+)'/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    return `URI='${proxyUrl(proxyOrigin, resolved)}'`;
  });

  /* Rewrite every non-comment line (segment URLs & child manifests) */
  return out
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;
      return proxyUrl(proxyOrigin, resolveUrl(base, trimmed));
    })
    .join("\n");
}

/* ── Manifest detection ──────────────────────────────────────────
   Works by CONTENT not just extension, so .m3 / .php / no-ext
   IPTV streams are handled correctly.                            */
function looksLikeManifestUrl(url, contentType) {
  /* Extension-based hints */
  if (/\.(m3u8?|m3)([\?#]|$)/i.test(url)) return true;
  /* Content-Type-based hints */
  if (contentType && /mpegurl|m3u/i.test(contentType)) return true;
  /* Common IPTV path patterns (no extension) */
  if (/\/(video|stream|live|hls|channel|play)(\.m3|\/|$)/i.test(url)) return true;
  return false;
}

/* ── Main handler ────────────────────────────────────────────── */
export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl  = new URL(request.url);
  const target  = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url param", { status: 400, headers: corsHeaders() });
  }

  /* Build request headers for this specific upstream */
  const upstreamHeaders = headersForUrl(target);
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  /* Fetch upstream */
  let upstream;
  try {
    upstream = await fetch(target, { headers: upstreamHeaders, redirect: "follow" });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream returned HTTP ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(),
    });
  }

  const proxyOrigin = reqUrl.origin;
  const contentType = upstream.headers.get("content-type") || "";

  /* ── Try manifest detection & rewrite ── */
  if (looksLikeManifestUrl(target, contentType)) {
    const text = await upstream.text();
    const trimmed = text.trimStart();

    /* Confirm it really is an M3U8 by checking the content */
    if (trimmed.startsWith("#EXTM3U") || trimmed.includes("#EXTINF")) {
      return new Response(rewriteManifest(text, target, proxyOrigin), {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }

    /* Looked like a manifest by URL/type but wasn't — fall through to binary */
  }

  /* ── Binary passthrough (TS segments, keys, etc.) ── */
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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/* ── CORS headers ────────────────────────────────────────────── */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
}
