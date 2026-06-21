export const config = { runtime: "edge" };

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           DeepStream — Multi-Playlist Configuration             ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  HOW TO ADD / REMOVE PLAYLISTS:                                 ║
 * ║  1. Edit the PLAYLIST_SOURCES array below                       ║
 * ║  2. Each entry needs: { name, url }                             ║
 * ║  3. Push to GitHub → Vercel auto-redeploys → done!              ║
 * ║                                                                 ║
 * ║  Supported formats: .m3u  .m3u8  (IPTV / HLS playlists)        ║
 * ║                                                                 ║
 * ║  CUSTOM URL (one-off, no redeploy needed):                      ║
 * ║  Call  /api/playlist?add=https://your-link.com/list.m3u8        ║
 * ║  This appends a custom URL to the merged result on-the-fly.     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const PLAYLIST_SOURCES = [
  // ── SOURCE 1 ────────────────────────────────────────────────────
  {
    name: "FanCode Live Events",
    url: "https://raw.githubusercontent.com/halo-ab/Matches-playlist-/refs/heads/main/Playlist.m3u",
  },

  // ── ADD MORE SOURCES BELOW ───────────────────────────────────────
  // Copy-paste any block and fill in name + url:

   {
     name: "My Sports Playlist",
    url: "https://github.com/halo-ab/Matches-playlist-/blob/main/Playlist.m3u",
  },

  // {
  //   name: "Formula 1 Streams",
  //   url: "https://example.com/f1/playlist.m3u8",
  // },

  // {
  //   name: "Football Channels",
  //   url: "https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/football.m3u",
  // },
];

/* ── Fetch headers (spoofed to pass most origin checks) ─────────── */
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/plain, application/vnd.apple.mpegurl, */*",
};

/* ── Fetch a single playlist source ─────────────────────────────── */
async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      headers: FETCH_HEADERS,
      cache: "no-store",
    });

    if (!res.ok) {
      console.error(`[playlist] ${source.name} returned HTTP ${res.status}`);
      return null;
    }

    const text = await res.text();

    if (!text.includes("#EXTINF") && !text.includes("#EXTM3U")) {
      console.error(`[playlist] ${source.name} — not a valid M3U/M3U8`);
      return null;
    }

    /* Strip the #EXTM3U header line (we'll write one combined header) */
    return text.replace(/^#EXTM3U[^\n]*\n?/m, "").trim();
  } catch (err) {
    console.error(`[playlist] ${source.name} fetch failed:`, err.message);
    return null;
  }
}

/* ── Main handler ────────────────────────────────────────────────── */
export default async function handler(req) {
  const reqUrl = new URL(req.url);

  /* Build source list — start with configured sources */
  const sources = [...PLAYLIST_SOURCES];

  /* Support ?add=<url> to inject a custom playlist on-the-fly */
  const addParam = reqUrl.searchParams.get("add");
  if (addParam) {
    try {
      const addUrl = new URL(addParam); /* validates the URL */
      sources.push({ name: "Custom (ad-hoc)", url: addUrl.href });
    } catch {
      /* ignore invalid URLs */
    }
  }

  if (!sources.length) {
    return new Response("No playlist sources configured", {
      status: 503,
      headers: corsHeaders(),
    });
  }

  /* Fetch all sources in parallel */
  const results = await Promise.all(sources.map(fetchSource));

  /* Filter out failures and join */
  const segments = results
    .map((text, i) => {
      if (!text) return null;
      /* Add a group comment so you can see which source each channel came from */
      return `## ── ${sources[i].name} ──\n${text}`;
    })
    .filter(Boolean);

  if (!segments.length) {
    return new Response("All playlist sources failed to load", {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const merged = `#EXTM3U\n${segments.join("\n\n")}`;

  return new Response(merged, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Sources-Loaded": `${segments.length}/${sources.length}`,
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
