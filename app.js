/**
 * DeepStream — M3U8 playlist parser & HLS player
 * Loads the bundled fancode.m3u playlist on startup.
 */


/** @typedef {{ title: string, url: string, logo: string, group: string, duration: number }} Channel */

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

const PLAYLIST_URL =
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.m3u";
const PLAYLIST_REFRESH_MS = 5 * 60 * 1000;

/** @param {string} url */
function proxiedStreamUrl(url) {
  return `${window.location.origin}/api/hls?url=${encodeURIComponent(url)}`;
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

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || (line.startsWith("#") && !line.startsWith("#EXTINF"))) continue;

    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinf(line);
      continue;
    }

    if (line.startsWith("#")) continue;

    if (isStreamUrl(line)) {
      if (pending) {
        result.push({
          title: pending.title || "Untitled Stream",
          url: line,
          logo: pending.logo || "",
          group: pending.group || "Uncategorized",
          duration: pending.duration ?? -1,
        });
        pending = null;
      } else {
        result.push({
          title: deriveTitleFromUrl(line),
          url: line,
          logo: "",
          group: "Direct Streams",
          duration: -1,
        });
      }
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

  if (Hls.isSupported()) {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    hls = new Hls({
      enableWorker: !isMobile,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 4,
      levelLoadingTimeOut: 20000,
      fragLoadingTimeOut: 30000,
      fragLoadingMaxRetry: 6,
      xhrSetup(xhr) {
        xhr.withCredentials = false;
      },
    });

    hls.loadSource(proxiedStreamUrl(ch.url));
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
    video.src = proxiedStreamUrl(ch.url);
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

/** @param {import('hls.js').ErrorData} data */
function handleFatalError(data) {
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    hls?.recoverMediaError();
    return;
  }

  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
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
