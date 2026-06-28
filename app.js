/**
 * DeepStream — M3U8 playlist parser & HLS player
 * Loads the bundled fancode.m3u playlist on startup.
 */


/** @typedef {{ title: string, url: string, logo: string, group: string, duration: number, headers: {userAgent: string, referer: string}, drm: {type: string, key: string} | null, isMpd: boolean }} Channel */

const $ = (sel) => document.querySelector(sel);

const video = $("#video");
const channelList = $("#channel-list");
const channelSearch = $("#channel-search");
const channelCount = $("#channel-count");
const playerOverlay = $("#player-overlay");
const playerLoading = $("#player-loading");
const playerError = $("#player-error");
const errorMessage = $("#error-message");
const nowTitle = $("#now-title");
const nowGroup = $("#now-group");
const nowUrl = $("#now-url");
const nowLogo = $("#now-logo");

/** @type {Channel[]} */
let channels = [];
/** @type {Channel | null} */
let activeChannel = null;
/** @type {Hls | null} */
let hls = null;
let networkRetries = 0;
/** @type {any} */
let dashPlayer = null;

const PLAYLIST_URL =
  "https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.m3u";
const PLAYLIST_REFRESH_MS = 5 * 60 * 1000;

/**
 * Build proxy URL with optional custom headers.
 * @param {string} url
 * @param {{userAgent?: string, referer?: string}} [headers]
 */
function proxiedStreamUrl(url, headers) {
  const isDirectIP = /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i.test(url);
  const isMpd     = /\.mpd([\?#]|$)/i.test(url);
  /* MPD (DASH) and direct-IP streams use Node.js/Lambda proxy.
     Edge (Cloudflare) works for HLS CDNs but gets blocked by live IPTV
     and FanCode's live streaming CDN (in-mc-flive.fancode.com). */
  const endpoint = (isDirectIP || isMpd) ? "/api/hlsnode" : "/api/hls";
  let proxyUrl = `${window.location.origin}${endpoint}?url=${encodeURIComponent(url)}`;
  if (headers?.userAgent) proxyUrl += `&ua=${encodeURIComponent(headers.userAgent)}`;
  if (headers?.referer)   proxyUrl += `&referer=${encodeURIComponent(headers.referer)}`;
  return proxyUrl;
}

/**
 * Parse IPTV-style M3U/M3U8 playlist text into channel entries.
 * @param {string} text
 * @returns {Channel[]}
 */
function parsePlaylist(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const result = [];
  /** @type {Partial<Channel> | null} */
  let pending = null;
  let pendingProps = { userAgent: "", referer: "", drmType: "", drmKey: "" };

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    /* ── KODIPROP: DRM metadata ── */
    if (line.startsWith("#KODIPROP:")) {
      const kv = line.slice("#KODIPROP:".length);
      const eqIdx = kv.indexOf("=");
      if (eqIdx > 0) {
        const key = kv.slice(0, eqIdx).trim();
        const val = kv.slice(eqIdx + 1).trim();
        if (key === "inputstream.adaptive.license_type") pendingProps.drmType = val;
        else if (key === "inputstream.adaptive.license_key") pendingProps.drmKey = val;
      }
      continue;
    }

    /* ── EXTVLCOPT: custom headers (http-referer OR http-referrer) ── */
    if (line.startsWith("#EXTVLCOPT:")) {
      const kv = line.slice("#EXTVLCOPT:".length);
      if (kv.startsWith("http-user-agent=")) pendingProps.userAgent = kv.slice("http-user-agent=".length);
      else if (kv.startsWith("http-referrer=")) pendingProps.referer = kv.slice("http-referrer=".length);
      else if (kv.startsWith("http-referer="))  pendingProps.referer = kv.slice("http-referer=".length);
      continue;
    }

    /* ── EXTHTTP: JSON header object ── */
    if (line.startsWith("#EXTHTTP:")) {
      try {
        const obj = JSON.parse(line.slice("#EXTHTTP:".length));
        if (obj["user-agent"]) pendingProps.userAgent = obj["user-agent"];
        if (obj["referer"])    pendingProps.referer    = obj["referer"];
        if (obj["referrer"])   pendingProps.referer    = obj["referrer"];
      } catch { /* ignore malformed JSON */ }
      continue;
    }

    /* ── EXTINF ── */
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinf(line);
      continue;
    }

    if (line.startsWith("#")) continue;

    /* ── URL line — parse pipe-separated headers ── */
    let url = line;
    const pipeHeaders = { userAgent: "", referer: "" };
    const pipeIdx = line.indexOf("|");
    if (pipeIdx > 0) {
      url = line.slice(0, pipeIdx);
      const headerStr = line.slice(pipeIdx + 1);
      for (const part of headerStr.split("&")) {
        const eq = part.indexOf("=");
        if (eq > 0) {
          const k = part.slice(0, eq).trim().toLowerCase();
          const v = part.slice(eq + 1).trim();
          if (k === "user-agent") pipeHeaders.userAgent = v;
          else if (k === "referer") pipeHeaders.referer = v;
        }
      }
    }

    if (isStreamUrl(url)) {
      const headers = {
        userAgent: pipeHeaders.userAgent || pendingProps.userAgent || "",
        referer: pipeHeaders.referer || pendingProps.referer || "",
      };
      const drm = pendingProps.drmType
        ? { type: normalizeDrmType(pendingProps.drmType), key: pendingProps.drmKey || "" }
        : null;
      const isMpd = /\.mpd(\?|$)/i.test(url);

      if (pending) {
        result.push({
          title: pending.title || "Untitled Stream",
          url, logo: pending.logo || "",
          group: pending.group || "Uncategorized",
          duration: pending.duration ?? -1,
          headers, drm, isMpd,
        });
        pending = null;
      } else {
        result.push({
          title: deriveTitleFromUrl(url),
          url, logo: "",
          group: "Direct Streams",
          duration: -1,
          headers, drm, isMpd,
        });
      }
      /* Reset pending props for next entry */
      pendingProps = { userAgent: "", referer: "", drmType: "", drmKey: "" };
    }
  }

  return result;
}

/** @param {string} line */
function parseExtinf(line) {
  const body = line.slice("#EXTINF:".length);
  const commaIdx = body.lastIndexOf(",");
  const metaPart = commaIdx >= 0 ? body.slice(0, commaIdx) : body;
  const titlePart = commaIdx >= 0 ? body.slice(commaIdx + 1).trim() : "";

  const duration = parseFloat(metaPart.split(",")[0]) || -1;
  const logo = extractAttr(metaPart, "tvg-logo") || extractAttr(metaPart, "logo") || "";
  const group = extractAttr(metaPart, "group-title") || extractAttr(metaPart, "group") || "Uncategorized";

  let title = titlePart;
  if (!title) {
    title = extractAttr(metaPart, "tvg-name") || extractAttr(metaPart, "tvg-id") || "Untitled Stream";
  }

  title = title.replace(/^["']|["']$/g, "").trim();
  return { title, logo, group, duration };
}

/** @param {string} str @param {string} name */
function extractAttr(str, name) {
  const patterns = [
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"),
    new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"),
    new RegExp(`${name}\\s*=\\s*([^\\s,"']+)`, "i"),
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

/** @param {string} url */
function isStreamUrl(url) {
  return /^https?:\/\//i.test(url) || url.endsWith(".m3u8") || url.endsWith(".m3u");
}

/** @param {string} url */
function deriveTitleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "Stream";
    return last.replace(/\.m3u8?$/i, "").replace(/[_-]/g, " ");
  } catch {
    return "Stream";
  }
}

/** @param {Channel[]} list */
function renderChannelList(list) {
  if (!list.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No channels found</p></div>`;
    channelCount.textContent = "0 channels";
    return;
  }

  const grouped = new Map();
  for (const ch of list) {
    const g = ch.group || "Uncategorized";
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(ch);
  }

  const frag = document.createDocumentFragment();
  for (const [group, items] of grouped) {
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = group;
    frag.appendChild(label);
    for (const ch of items) frag.appendChild(createChannelButton(ch));
  }

  channelList.innerHTML = "";
  channelList.appendChild(frag);
  channelCount.textContent = `${list.length} channel${list.length === 1 ? "" : "s"}`;
}

/** @param {Channel} ch */
function createChannelButton(ch) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "channel-item";
  btn.dataset.url = ch.url;
  if (activeChannel?.url === ch.url) btn.classList.add("active");

  const logoEl = ch.logo
    ? Object.assign(document.createElement("img"), {
        className: "channel-logo",
        src: ch.logo,
        alt: "",
        loading: "lazy",
      })
    : (() => {
        const div = document.createElement("div");
        div.className = "channel-logo placeholder";
        div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`;
        return div;
      })();

  logoEl.onerror = () => {
    const div = document.createElement("div");
    div.className = "channel-logo placeholder";
    div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`;
    logoEl.replaceWith(div);
  };

  const meta = document.createElement("div");
  meta.className = "channel-meta";
  meta.innerHTML = `
    <div class="channel-name">${escapeHtml(ch.title)}</div>
    <div class="channel-group">${escapeHtml(ch.group)}</div>`;

  btn.append(logoEl, meta);
  btn.addEventListener("click", () => playChannel(ch));
  return btn;
}

/** @param {string} s */
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** @param {Channel} ch */
function playChannel(ch) {
  activeChannel = ch;
  updateNowPlaying(ch);
  highlightActiveChannel(ch.url);
  closeDrawer();

  destroyPlayer();
  networkRetries = 0;
  showLoading(true);
  hideError();
  playerOverlay.classList.add("hidden");

  if (ch.isMpd) {
    playDash(ch);
  } else {
    playHls(ch);
  }
}

/** Play an HLS (.m3u8) stream */
function playHls(ch) {
  if (Hls.isSupported()) {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isIPTV   = /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i.test(ch.url);

    hls = new Hls({
      enableWorker: !isMobile,
      lowLatencyMode: !isIPTV,
      startLevel: -1,
      backBufferLength: isIPTV ? 60 : 30,
      maxBufferLength: isIPTV ? 60 : 30,
      maxMaxBufferLength: isIPTV ? 120 : 60,
      maxBufferHole: 1.5,
      manifestLoadingTimeOut: 25000,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      levelLoadingTimeOut: 25000,
      levelLoadingMaxRetry: 6,
      levelLoadingRetryDelay: 1000,
      fragLoadingTimeOut: 40000,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 1000,
      xhrSetup(xhr) {
        xhr.withCredentials = false;
      },
    });

    hls.loadSource(proxiedStreamUrl(ch.url, ch.headers));
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      showLoading(false);
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        showLoading(false);
        handleFatalError(data);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = proxiedStreamUrl(ch.url, ch.headers);
    video.addEventListener(
      "loadedmetadata",
      () => {
        showLoading(false);
        video.play().catch(() => {});
      },
      { once: true }
    );
    video.addEventListener(
      "error",
      () => {
        showLoading(false);
        showError("Native HLS playback failed. The stream may be geo-blocked or expired.");
      },
      { once: true }
    );
  } else {
    showLoading(false);
    showError("HLS is not supported in this browser.");
  }
}

/** Lazy-load Shaka Player on first use */
let _shakaPromise = null;
function loadShaka() {
  if (_shakaPromise) return _shakaPromise;
  _shakaPromise = new Promise((resolve, reject) => {
    if (typeof window.shaka !== "undefined") { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/shaka-player@4.11.0/dist/shaka-player.compiled.js";
    s.crossOrigin = "anonymous";
    s.onload = () => {
      /* Install polyfills required by Shaka */
      window.shaka.polyfill.installAll();
      resolve();
    };
    s.onerror = () => {
      /* Fallback to Google CDN */
      const s2 = document.createElement("script");
      s2.src = "https://ajax.googleapis.com/ajax/libs/shaka-player/4.11.0/shaka-player.compiled.js";
      s2.crossOrigin = "anonymous";
      s2.onload = () => { window.shaka.polyfill.installAll(); resolve(); };
      s2.onerror = () => reject(new Error("Shaka Player failed to load"));
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
  return _shakaPromise;
}

/** Play a DASH (.mpd) stream with optional Clearkey DRM using Shaka Player */
function playDash(ch) {
  showLoading(true);
  loadShaka().then(() => _startShakaPlayer(ch)).catch((err) => {
    showLoading(false);
    showError("DASH player failed to load: " + err.message);
  });
}

function _startShakaPlayer(ch) {
  if (!window.shaka.Player.isBrowserSupported()) {
    showLoading(false);
    showError("Your browser does not support DASH/DRM playback. Try Chrome or Edge.");
    return;
  }

  dashPlayer = new window.shaka.Player();

  /* Always log errors for debugging */
  dashPlayer.addEventListener("error", (e) => {
    const err = e.detail;
    console.error("[Shaka] Error cat=" + err.category + " code=" + err.code, err);
  });

  const buildConfig = () => {
    const cfg = {
      streaming: {
        bufferingGoal:     30,
        rebufferingGoal:    1,
        bufferBehind:      30,
        jumpLargeGaps:   true,   /* Skip large PTO gaps in live streams */
        alwaysStreamText: false,
        retryParameters: { maxAttempts: 5, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.5 },
      },
      manifest: {
        retryParameters: { maxAttempts: 5, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.5 },
      },
    };
    /* ClearKey DRM */
    if (ch.drm && ch.drm.type === "org.w3.clearkey" && ch.drm.key) {
      try {
        const clearKeys = parseClearkeys(JSON.parse(ch.drm.key));
        cfg.drm = { clearKeys };
        console.log("[DRM] ClearKey keys:", Object.keys(clearKeys));
      } catch (e) { console.warn("DRM parse error:", e); }
    }
    return cfg;
  };

  dashPlayer.attach(video).then(() => {
    dashPlayer.configure(buildConfig());
    const net = dashPlayer.getNetworkingEngine();

    /* ── Strategy 1: Load directly from CDN with native Shaka headers ──────
       FanCode's web app uses the same CDN so it must have CORS.
       Shaka sets Referer natively in XHR (allowed header).             */
    net.clearAllRequestFilters();
    net.registerRequestFilter((type, request) => {
      if (ch.headers.referer)   request.headers["Referer"]   = ch.headers.referer;
      if (ch.headers.userAgent) request.headers["User-Agent"] = ch.headers.userAgent;
    });

    console.log("[Shaka] Trying direct CDN:", ch.url);
    return dashPlayer.load(ch.url).then(() => "direct");

  }).catch((err1) => {
    /* ── Strategy 2: Route everything through our Node.js proxy ─────────── */
    console.warn("[Shaka] Direct failed (cat=" + (err1.category||"?") + " code=" + (err1.code||"?") + "), using proxy...");
    return dashPlayer.unload().then(() => {
      const net = dashPlayer.getNetworkingEngine();
      net.clearAllRequestFilters();
      net.registerRequestFilter((type, request) => {
        request.uris = request.uris.map((uri) => {
          if (!uri || uri.startsWith(window.location.origin)) return uri;
          return proxiedStreamUrl(uri, ch.headers);
        });
      });
      const proxyUrl = proxiedStreamUrl(ch.url, ch.headers);
      console.log("[Shaka] Trying proxy:", proxyUrl);
      return dashPlayer.load(proxyUrl).then(() => "proxy");
    });

  }).then((strategy) => {
    console.log("[Shaka] Loaded via", strategy);
    showLoading(false);

    /* ── Seek to live edge ──
       FanCode F1 streams have a huge Presentation Time Offset but
       Shaka's isLive() may return false. Detect live-like streams by
       checking if duration > 24 hours OR if isLive() is true.
       Seek to 5 seconds before the live edge (exact edge may not
       have segments downloaded yet). */
    const isLive     = dashPlayer.isLive?.() === true;
    const hugeVOD    = isFinite(video.duration) && video.duration > 86400;  /* > 24 hrs = live PTO */
    const seekRange  = dashPlayer.seekRange?.();

    console.log("[Shaka] isLive=" + isLive + " duration=" + video.duration +
                " seekRange=" + JSON.stringify(seekRange));

    if (isLive || hugeVOD) {
      if (seekRange && seekRange.end > 0) {
        const target = Math.max(seekRange.end - 5, seekRange.start);
        console.log("[Shaka] Seeking to live edge:", target);
        video.currentTime = target;
      } else if (hugeVOD) {
        /* Fallback: seek near the end of the video */
        const target = video.duration - 10;
        console.log("[Shaka] Seeking near end of VOD:", target);
        video.currentTime = target;
      }
    }

    video.play().catch(() => {});

  }).catch((err) => {
    console.error("[Shaka] Both strategies failed:", err);
    showLoading(false);
    const cat    = err?.category ?? "?";
    const code   = err?.code     ?? "?";
    const status = err?.data?.[1] ?? "";          /* HTTP status for 1:1001 errors */
    let   msg    = `Stream error [${cat}:${code}${status ? " HTTP " + status : ""}]`;
    if (cat === 1 && code === 1001) {
      if (status === 403) msg += " — CDN refused (geo-blocked or expired token).";
      else if (!status)   msg += " — CORS blocked or network unreachable.";
      else                msg += " — CDN returned HTTP " + status + ".";
    } else if (cat === 7) {
      msg += " — DRM error. The decryption key may be invalid.";
    } else if (cat === 4) {
      msg += " — MPD manifest could not be parsed.";
    } else {
      msg += " — Stream may be offline or expired.";
    }
    showError(msg);
  });
}


/**
 * Normalize DRM type strings to standard W3C key system names.
 * Kodi uses non-standard aliases like com.clearkey.alpha.
 */
function normalizeDrmType(type) {
  const t = (type || "").toLowerCase();
  if (t === "org.w3.clearkey" || t === "com.clearkey.alpha" || t === "clearkey") {
    return "org.w3.clearkey";
  }
  return t; /* widevine, playready, etc. passed through as-is */
}

/**
 * Convert base64url string → hex string (for dash.js clearkeys format).
 * dash.js expects hex kid/key pairs, but Kodi playlists use base64url.
 */
function base64urlToHex(b64url) {
  /* Restore base64 padding and replace URL-safe chars */
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  return Array.from(binary)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parse Clearkey JSON (Kodi/W3C format) into hex {kid: key} map for dash.js.
 * Input: {"keys":[{"kty":"oct","k":"base64url","kid":"base64url"}],"type":"temporary"}
 * Note: field may be "key" or "k" depending on the playlist generator.
 */
function parseClearkeys(keyData) {
  const map = {};
  if (keyData && keyData.keys) {
    for (const k of keyData.keys) {
      /* Support both "key"/"k" field names */
      const keyVal = k.key || k.k;
      const kidVal = k.kid;
      if (kidVal && keyVal) {
        try {
          /* Convert base64url → hex for dash.js */
          map[base64urlToHex(kidVal)] = base64urlToHex(keyVal);
        } catch (e) {
          /* Fallback: use values as-is if conversion fails */
          map[kidVal] = keyVal;
        }
      }
    }
  }
  return map;
}

/** @param {import('hls.js').ErrorData} data */
function handleFatalError(data) {
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    hls?.recoverMediaError();
    return;
  }

  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 5) {
    networkRetries += 1;
    hls?.startLoad();
    return;
  }

  showError("Stream unavailable — may be offline, expired, or geo-blocked in your region.");
}

function destroyPlayer() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (dashPlayer) {
    /* Shaka Player uses destroy() */
    try { dashPlayer.destroy(); } catch (e) {}
    dashPlayer = null;
  }
  video.removeAttribute("src");
  video.load();
}

/** @param {Channel} ch */
function updateNowPlaying(ch) {
  nowTitle.textContent = ch.title;
  nowGroup.textContent = ch.group;
  nowUrl.textContent = ch.url;

  if (ch.logo) {
    nowLogo.src = ch.logo;
    nowLogo.classList.remove("hidden");
    nowLogo.onerror = () => nowLogo.classList.add("hidden");
  } else {
    nowLogo.classList.add("hidden");
    nowLogo.removeAttribute("src");
  }

  if (ch.logo) video.poster = ch.logo;
}

/** @param {string} url */
function highlightActiveChannel(url) {
  channelList.querySelectorAll(".channel-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.url === url);
  });
}

/** @param {boolean} on */
function showLoading(on) {
  playerLoading.classList.toggle("hidden", !on);
}

/** @param {string} msg */
function showError(msg) {
  errorMessage.textContent = msg;
  playerError.classList.remove("hidden");
  playerOverlay.classList.add("hidden");
}

function hideError() {
  playerError.classList.add("hidden");
}

/** @param {string} text */
function loadPlaylistText(text) {
  channels = parsePlaylist(text);
  renderChannelList(channels);
}

async function fetchPlaylistText() {
  const bust = Date.now();
  const sources = [
    `/api/playlist?_=${bust}`,
    `${PLAYLIST_URL}?_=${bust}`,
    `/fancode.m3u?_=${bust}`,
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes("#EXTINF")) return text;
    } catch {
      /* try next source */
    }
  }

  return null;
}

async function loadPlaylist() {
  channelCount.textContent = "Loading…";

  const text = await fetchPlaylistText();

  if (!text) {
    channelList.innerHTML = `<div class="empty-state"><p>Could not load playlist</p></div>`;
    channelCount.textContent = "Error";
    return;
  }

  loadPlaylistText(text);
}

function startPlaylistRefresh() {
  setInterval(async () => {
    const text = await fetchPlaylistText();
    if (!text) return;

    const prev = activeChannel?.url;
    loadPlaylistText(text);

    if (prev) highlightActiveChannel(prev);
  }, PLAYLIST_REFRESH_MS);
}

function filterChannels(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    renderChannelList(channels);
    return;
  }
  const filtered = channels.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      c.url.toLowerCase().includes(q)
  );
  renderChannelList(filtered);
}

channelSearch.addEventListener("input", (e) => filterChannels(e.target.value));

const sidebar = $("#sidebar");
const drawerBackdrop = $("#drawer-backdrop");

function openDrawer() {
  sidebar.classList.add("open");
  drawerBackdrop.classList.remove("hidden");
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  sidebar.classList.remove("open");
  drawerBackdrop.classList.add("hidden");
  document.body.classList.remove("drawer-open");
}

$("#btn-channels")?.addEventListener("click", openDrawer);
$("#btn-close-drawer")?.addEventListener("click", closeDrawer);
drawerBackdrop?.addEventListener("click", closeDrawer);

$("#btn-retry").addEventListener("click", () => {
  if (activeChannel) playChannel(activeChannel);
});

window.addEventListener("beforeunload", destroyPlayer);

loadPlaylist();
startPlaylistRefresh();
