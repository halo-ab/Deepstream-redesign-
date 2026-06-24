/**
 * DeepStream — HLS Proxy for IPTV / Direct-IP streams
 * Uses Node.js Serverless Runtime (AWS Lambda IPs)
 *
 * This endpoint is used for streams on direct IPs or non-CDN servers
 * that block Vercel's Edge (Cloudflare) IPs.
 *
 * Identical logic to api/hls.js but runs on Node.js instead of Edge.
 */

/* No "export const config = { runtime: 'edge' }" → defaults to Node.js serverless */

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  try { return new URL(relative, base).href; } catch { return relative; }
}

function proxyUrl(origin, target) {
  /* IMPORTANT: rewrites point back to /api/hlsnode (this file), not /api/hls */
  return `${origin}/api/hlsnode?url=${encodeURIComponent(target)}`;
}

function rewriteManifest(text, sourceUrl, proxyOrigin) {
  const base = sourceUrl.replace(/\/[^/]*(\?.*)?$/, "/");

  let out = text
    .replace(/URI="([^"]+)"/gi, (_, u) => `URI="${proxyUrl(proxyOrigin, resolveUrl(base, u))}"`)
    .replace(/URI='([^']+)'/gi, (_, u) => `URI='${proxyUrl(proxyOrigin, resolveUrl(base, u))}'`);

  return out.split(/\r?\n/).map((line) => {
    const t = line.trimEnd();
    if (!t || t.startsWith("#")) return t;
    return proxyUrl(proxyOrigin, resolveUrl(base, t));
  }).join("\n");
}

function looksLikeManifest(url, contentType) {
  if (/\.(m3u8?|m3)([\?#]|$)/i.test(url)) return true;
  if (contentType && /mpegurl|m3u/i.test(contentType)) return true;
  if (/\/(video|stream|live|hls|channel|play)(\/|\.m3|$)/i.test(url)) return true;
  return false;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url param", { status: 400, headers: corsHeaders() });
  }

  const upstreamHeaders = { ...BASE_HEADERS };
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

  if (looksLikeManifest(target, contentType)) {
    const text    = await upstream.text();
    const trimmed = text.trimStart();

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
  }

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
