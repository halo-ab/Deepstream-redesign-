export const config = { runtime: "edge" };

const UPSTREAM_HEADERS = {
  Referer: "https://www.fancode.com/",
  Origin: "https://www.fancode.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
};

function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  const baseDir = base.endsWith("/") ? base : base.replace(/\/[^/]*$/, "/");
  return new URL(relative, baseDir).href;
}

function proxyUrl(proxyOrigin, target) {
  return `${proxyOrigin}/api/hls?url=${encodeURIComponent(target)}`;
}

function rewriteManifest(text, sourceUrl, proxyOrigin) {
  const base = sourceUrl.endsWith("/") ? sourceUrl : sourceUrl.replace(/\/[^/]*$/, "/");

  let out = text.replace(/URI="([^"]+)"/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    return `URI="${proxyUrl(proxyOrigin, resolved)}"`;
  });

  out = out.replace(/URI='([^']+)'/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    return `URI='${proxyUrl(proxyOrigin, resolved)}'`;
  });

  return out
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;
      return proxyUrl(proxyOrigin, resolveUrl(base, trimmed));
    })
    .join("\n");
}

function isManifestUrl(url) {
  return /\.m3u8?(\?|$)/i.test(url);
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url", { status: 400, headers: corsHeaders() });
  }

  const upstreamHeaders = { ...UPSTREAM_HEADERS };
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(),
    });
  }

  const proxyOrigin = reqUrl.origin;

  if (isManifestUrl(target)) {
    const text = await upstream.text();
    if (text.startsWith("#EXTM3U")) {
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

  const headers = {
    ...corsHeaders(),
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
  };

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers["Content-Range"] = contentRange;

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;

  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) headers["Accept-Ranges"] = acceptRanges;

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}
