/**
 * /api/dash.js  —  Dedicated DASH/MPD proxy (Node.js Serverless)
 *
 * A clean, pure-passthrough proxy for DASH streams:
 *  - Fetches MPD manifests and media segments from upstream CDN
 *  - Forwards custom User-Agent + Referer headers
 *  - Returns response with CORS headers so Shaka Player can access it
 *  - NO manifest rewriting, NO HLS logic, NO buffering for segments
 *  - Just a transparent pipe with CORS
 *
 * Query params:
 *   ?url=<encoded upstream URL>
 *   &ua=<encoded User-Agent>        (optional)
 *   &referer=<encoded Referer>      (optional)
 */

const http  = require("http");
const https = require("https");

/* Keep-alive agents for connection reuse */
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 30 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30, rejectUnauthorized: false });

const DEFAULT_UA = "ReactNativeVideo/9.7.0 (Linux;Android 10) AndroidXMedia3/1.6.1";

/* ── CORS headers ───────────────────────────────────────── */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Origin");
  res.setHeader("Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Content-Type, Accept-Ranges");
}

/* ── Fetch upstream ─────────────────────────────────────── */
function fetchUpstream(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const parsed    = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      agent:    parsed.protocol === "https:" ? httpsAgent : httpAgent,
      headers:  {
        "User-Agent": headers.ua || DEFAULT_UA,
        Accept: "*/*",
        Connection: "keep-alive",
        ...(headers.referer ? { Referer: headers.referer } : {}),
        ...(headers.origin  ? { Origin:  headers.origin  } : {}),
      },
      timeout: 30000,
    };

    const req = transport.request(opts, (upstream) => {
      /* Handle redirects */
      if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
        let redirectUrl = upstream.headers.location;
        if (redirectUrl.startsWith("/")) {
          redirectUrl = parsed.protocol + "//" + parsed.host + redirectUrl;
        }
        upstream.resume(); /* Drain old response */
        fetchUpstream(redirectUrl, headers).then(resolve).catch(reject);
        return;
      }
      resolve(upstream);
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.on("error",   (e) => reject(e));
    req.end();
  });
}

/* ── Main handler ───────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCors(res);

  /* Handle CORS preflight */
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const target = params.get("url");

  if (!target) {
    res.statusCode = 400;
    return res.end("Missing ?url= parameter");
  }

  const headers = {
    ua:      params.get("ua")      || DEFAULT_UA,
    referer: params.get("referer") || "https://fancode.com/",
    origin:  params.get("origin")  || "",
  };

  try {
    const upstream = await fetchUpstream(target, headers);

    if (upstream.statusCode >= 400) {
      res.statusCode = upstream.statusCode;
      return res.end(`Upstream HTTP ${upstream.statusCode}`);
    }

    /* Forward relevant headers */
    const ct = upstream.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);

    const cl = upstream.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);

    const cr = upstream.headers["content-range"];
    if (cr) res.setHeader("Content-Range", cr);

    const ar = upstream.headers["accept-ranges"];
    if (ar) res.setHeader("Accept-Ranges", ar);

    res.setHeader("Cache-Control", "no-store");
    res.statusCode = upstream.statusCode || 200;

    /* Pure pipe — no buffering, no rewriting */
    upstream.pipe(res);

  } catch (err) {
    console.error("[dash] Proxy error:", err.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("DASH proxy error: " + err.message);
    }
  }
};
