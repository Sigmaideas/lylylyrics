/* lylylyrics — Cotodama-style lyric visualizer
 * Flow: YouTube link -> oEmbed metadata -> LRCLIB synced lyrics -> play & animate.
 */

"use strict";

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const els = {
  start: $("start"),
  stage: $("stage"),
  url: $("url"),
  artist: $("artist"),
  track: $("track"),
  go: $("go"),
  status: $("status"),
  lyrics: $("lyrics"),
  slotPrev: document.querySelector('[data-slot="prev"]'),
  slotCurrent: document.querySelector('[data-slot="current"]'),
  slotNext: document.querySelector('[data-slot="next"]'),
  slotNext2: document.querySelector('[data-slot="next2"]'),
  nowPlaying: $("nowPlaying"),
  controls: $("controls"),
  playPause: $("playPause"),
  fullscreen: $("fullscreen"),
  reset: $("reset"),
  trackInfo: $("track-info"),
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  player: null,
  lines: [], // [{ time: seconds, text }]
  index: -1, // current line index
  hasSynced: false,
  instrumental: false,
  meta: { artist: "", track: "" },
  playing: false,
};

/* ------------------------------------------------------------------ *
 * YouTube IFrame API
 * ------------------------------------------------------------------ */
let ytReadyResolve;
const ytReady = new Promise((res) => (ytReadyResolve = res));
window.onYouTubeIframeAPIReady = () => ytReadyResolve();

(function loadYT() {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
})();

function parseVideoId(input) {
  if (!input) return null;
  const raw = input.trim();
  // bare id
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.split("/").filter(Boolean)[0] || null;
    }
    // /embed/<id>, /shorts/<id>, /live/<id>
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  } catch {
    /* not a URL */
  }
  const m = raw.match(/[\w-]{11}/);
  return m ? m[0] : null;
}

/* ------------------------------------------------------------------ *
 * Metadata + lyrics
 * ------------------------------------------------------------------ */
const NOISE = [
  /\(.*?(official|lyric|audio|video|mv|m\/v|visualizer|performance|live|color\s*coded).*?\)/gi,
  /\[.*?(official|lyric|audio|video|mv|m\/v|visualizer|performance|live|color\s*coded).*?\]/gi,
  /\bofficial\b/gi,
  /\b(mv|m\/v|hd|4k|hq|audio|lyrics?|가사|뮤직비디오)\b/gi,
  /[「」『』]/g,
];

function cleanTitle(t) {
  let s = t || "";
  for (const re of NOISE) s = s.replace(re, " ");
  return s.replace(/\s{2,}/g, " ").trim();
}

// Split "Artist - Track" (handles a few dash variants) from a video title.
function guessArtistTrack(title, author) {
  const clean = cleanTitle(title);
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), track: parts.slice(1).join(" - ").trim() };
  }
  return { artist: cleanTitle(author || ""), track: clean };
}

// YouTube oEmbed sends CORS headers (reflects origin); noembed is a CORS=* backup.
async function fetchMeta(videoUrl) {
  const shape = (d) => ({
    title: d.title || "",
    author: (d.author_name || "").replace(/\s*-\s*Topic$/i, "").trim(),
  });
  const endpoints = [
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl)}`,
    `https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`,
  ];
  for (const u of endpoints) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const d = await r.json();
      if (d && d.title) return shape(d);
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

// LRCLIB (https://lrclib.net) is CORS-enabled, so we call it straight from the browser.
async function fetchLyrics({ artist, track, duration }) {
  const base = "https://lrclib.net/api";
  const pick = (d) => ({
    syncedLyrics: d.syncedLyrics || "",
    plainLyrics: d.plainLyrics || "",
  });

  // 1) exact lookup when we have a clean artist + track
  if (artist && track) {
    const p = new URLSearchParams({ artist_name: artist, track_name: track });
    if (duration) p.set("duration", String(Math.round(duration)));
    try {
      const r = await fetch(`${base}/get?${p}`);
      if (r.ok) {
        const d = await r.json();
        if (d && (d.syncedLyrics || d.plainLyrics)) return pick(d);
      }
    } catch {
      /* fall through to search */
    }
  }

  // 2) fuzzy search fallback
  const queries = [];
  if (artist && track) queries.push(`${artist} ${track}`);
  if (track) queries.push(track);
  for (const q of [...new Set(queries.map((s) => s.trim()).filter(Boolean))]) {
    try {
      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) continue;
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        const best = arr.find((x) => x.syncedLyrics) || arr[0];
        if (best && (best.syncedLyrics || best.plainLyrics)) return pick(best);
      }
    } catch {
      /* try next query */
    }
  }
  return null;
}

/* Parse standard LRC: lines like "[mm:ss.xx] text", possibly multi-timestamp. */
function parseLRC(lrc) {
  const out = [];
  const tag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of lrc.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = tag.exec(rawLine))) {
      const min = +m[1];
      const sec = +m[2];
      const frac = m[3] ? +`0.${m[3]}` : 0;
      stamps.push(min * 60 + sec + frac);
    }
    if (!stamps.length) continue;
    const text = rawLine.replace(tag, "").trim();
    for (const t of stamps) out.push({ time: t, text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/* Plain lyrics with no timing: spread evenly across the track duration. */
function estimateTiming(plain, duration) {
  const lines = plain
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const dur = duration && duration > 5 ? duration : lines.length * 4;
  const intro = Math.min(6, dur * 0.05);
  const span = dur - intro;
  return lines.map((text, i) => ({
    time: intro + (span * i) / lines.length,
    text,
  }));
}

/* ------------------------------------------------------------------ *
 * Start flow
 * ------------------------------------------------------------------ */
function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

async function start() {
  const videoId = parseVideoId(els.url.value);
  if (!videoId) {
    setStatus("유효한 유튜브 링크를 넣어주세요.", true);
    return;
  }
  els.go.disabled = true;
  setStatus("곡 정보를 불러오는 중…");

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1) figure out artist / track
  let artist = els.artist.value.trim();
  let track = els.track.value.trim();
  if (!artist || !track) {
    const meta = await fetchMeta(videoUrl);
    if (meta && meta.title) {
      const g = guessArtistTrack(meta.title, meta.author);
      artist = artist || g.artist;
      track = track || g.track;
    }
  }
  state.meta = { artist, track };

  // 2) start the player (user gesture -> autoplay with sound allowed)
  setStatus("플레이어 준비 중…");
  await ytReady;
  await createPlayer(videoId);
  const duration = safeDuration();

  // 3) lyrics
  setStatus("가사를 찾는 중…");
  let data = null;
  try {
    data = await fetchLyrics({ artist, track, duration });
  } catch {
    /* handled below */
  }

  applyLyrics(data, duration);

  // 4) reveal stage
  els.start.classList.add("hidden");
  els.stage.classList.remove("hidden");
  document.body.classList.toggle("instrumental", state.instrumental);
  els.nowPlaying.textContent = [artist, track].filter(Boolean).join(" — ");
  els.trackInfo.textContent = [artist, track].filter(Boolean).join(" — ");
  bumpControls();
  els.go.disabled = false;
}

function applyLyrics(data, duration) {
  state.lines = [];
  state.index = -1;
  state.hasSynced = false;
  state.instrumental = false;

  if (data && data.syncedLyrics) {
    state.lines = parseLRC(data.syncedLyrics);
    state.hasSynced = state.lines.length > 0;
  }
  if (!state.lines.length && data && data.plainLyrics) {
    state.lines = estimateTiming(data.plainLyrics, duration);
  }
  if (!state.lines.length) {
    state.instrumental = true;
    setStatus("");
  }
  renderSlots(); // initial paint
}

function createPlayer(videoId) {
  return new Promise((resolve) => {
    state.player = new YT.Player("player", {
      videoId,
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
      },
      events: {
        onReady: (e) => {
          e.target.playVideo();
          resolve();
        },
        onStateChange: (e) => {
          state.playing = e.data === YT.PlayerState.PLAYING;
          els.playPause.textContent = state.playing ? "⏸" : "▶";
        },
      },
    });
  });
}

function safeDuration() {
  try {
    const d = state.player.getDuration();
    return d && isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Sync loop
 * ------------------------------------------------------------------ */
function currentTime() {
  try {
    return state.player.getCurrentTime() || 0;
  } catch {
    return 0;
  }
}

function findIndex(t) {
  const lines = state.lines;
  let lo = 0,
    hi = lines.length - 1,
    res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

function tickLyrics() {
  if (state.instrumental || !state.lines.length) return;
  const t = currentTime();
  const idx = findIndex(t);
  if (idx !== state.index) {
    state.index = idx;
    renderSlots();
    viz.pulse(); // surge the visualization on each new line
  }
}

/* ------------------------------------------------------------------ *
 * Lyric rendering
 * ------------------------------------------------------------------ */
function lineText(i) {
  return i >= 0 && i < state.lines.length ? state.lines[i].text : "";
}

function wordize(el, text) {
  el.innerHTML = "";
  if (!text) return;
  const words = text.split(/(\s+)/);
  let wi = 0;
  for (const part of words) {
    if (/^\s+$/.test(part)) {
      el.appendChild(document.createTextNode(part));
      continue;
    }
    const span = document.createElement("span");
    span.className = "w";
    span.textContent = part;
    span.style.animationDelay = `${wi * 60}ms`;
    el.appendChild(span);
    wi++;
  }
}

function renderSlots() {
  const i = state.index;
  els.slotPrev.textContent = lineText(i - 1);
  els.slotNext.textContent = lineText(i + 1);
  els.slotNext2.textContent = lineText(i + 2);
  // current gets the per-word reveal
  const cur = lineText(i);
  if (cur) {
    wordize(els.slotCurrent, cur);
  } else {
    els.slotCurrent.innerHTML = state.instrumental
      ? `<span class="w">♪</span>`
      : "";
  }
}

/* ------------------------------------------------------------------ *
 * Visualization (animated gradient blobs + particle field)
 * ------------------------------------------------------------------ */
const viz = (() => {
  const canvas = $("viz");
  const ctx = canvas.getContext("2d");
  let w = 0,
    h = 0,
    dpr = 1;
  let energy = 0; // decays; bumped on each lyric line
  const particles = [];
  const blobs = [];

  const PALETTE = [
    [255, 61, 129],
    [106, 92, 255],
    [45, 226, 230],
    [255, 176, 59],
  ];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(innerWidth * dpr);
    h = canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function initParticles() {
    particles.length = 0;
    const count = Math.round((innerWidth * innerHeight) / 14000);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: rand(0, w),
        y: rand(0, h),
        r: rand(0.6, 2.4) * dpr,
        vx: rand(-0.15, 0.15) * dpr,
        vy: rand(-0.5, -0.1) * dpr,
        a: rand(0.1, 0.6),
        c: PALETTE[(Math.random() * PALETTE.length) | 0],
      });
    }
  }

  function initBlobs() {
    blobs.length = 0;
    for (let i = 0; i < 4; i++) {
      blobs.push({
        baseX: rand(0.2, 0.8),
        baseY: rand(0.2, 0.8),
        ax: rand(0.1, 0.3),
        ay: rand(0.1, 0.3),
        sx: rand(0.05, 0.18),
        sy: rand(0.05, 0.18),
        ph: rand(0, Math.PI * 2),
        c: PALETTE[i % PALETTE.length],
      });
    }
  }

  function pulse() {
    energy = Math.min(1.6, energy + 1);
    // burst of particles from center
    const cx = w / 2,
      cy = h * 0.5;
    const n = 18;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n + rand(-0.2, 0.2);
      const sp = rand(2, 6) * dpr;
      particles.push({
        x: cx,
        y: cy,
        r: rand(1.5, 3.5) * dpr,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        a: 0.9,
        decay: rand(0.012, 0.03),
        c: PALETTE[(Math.random() * PALETTE.length) | 0],
      });
    }
    // cap particle array
    if (particles.length > 600) particles.splice(0, particles.length - 600);
  }

  let t0 = 0;
  function frame(ts) {
    if (!t0) t0 = ts;
    const time = (ts - t0) / 1000;
    energy *= 0.96;

    // background base
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(5, 6, 10, 0.35)";
    ctx.fillRect(0, 0, w, h);

    // gradient blobs (additive glow)
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const x = (b.baseX + Math.sin(time * b.sx + b.ph) * b.ax) * w;
      const y = (b.baseY + Math.cos(time * b.sy + b.ph) * b.ay) * h;
      const rad = (Math.min(w, h) * 0.45) * (0.7 + energy * 0.35);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const [r, gg, bl] = b.c;
      const alpha = 0.12 + energy * 0.1;
      g.addColorStop(0, `rgba(${r},${gg},${bl},${alpha})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // particles
    const boost = 1 + energy * 1.4;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * boost;
      p.y += p.vy * boost;
      if (p.decay) {
        p.a -= p.decay;
        if (p.a <= 0) {
          particles.splice(i, 1);
          continue;
        }
      } else {
        // ambient particles wrap around
        if (p.y < -10) {
          p.y = h + 10;
          p.x = rand(0, w);
        }
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
      }
      const [r, g, b] = p.c;
      ctx.fillStyle = `rgba(${r},${g},${b},${p.a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + energy * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(frame);
  }

  function init() {
    resize();
    initParticles();
    initBlobs();
    requestAnimationFrame(frame);
    addEventListener("resize", () => {
      resize();
      initParticles();
    });
  }

  return { init, pulse };
})();

/* ------------------------------------------------------------------ *
 * Controls + idle UI
 * ------------------------------------------------------------------ */
let idleTimer;
function bumpControls() {
  els.controls.classList.add("show");
  els.controls.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    els.controls.classList.remove("show");
    els.controls.classList.add("idle");
  }, 2800);
}

function togglePlay() {
  try {
    if (state.playing) state.player.pauseVideo();
    else state.player.playVideo();
  } catch {}
}

function toggleFullscreen() {
  const root = document.documentElement;
  if (!document.fullscreenElement) {
    (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

function resetApp() {
  try {
    state.player && state.player.stopVideo();
  } catch {}
  els.stage.classList.add("hidden");
  els.start.classList.remove("hidden");
  document.body.classList.remove("instrumental");
  state.lines = [];
  state.index = -1;
  setStatus("");
}

/* ------------------------------------------------------------------ *
 * Wire-up
 * ------------------------------------------------------------------ */
els.go.addEventListener("click", start);
els.url.addEventListener("keydown", (e) => {
  if (e.key === "Enter") start();
});
els.playPause.addEventListener("click", togglePlay);
els.fullscreen.addEventListener("click", toggleFullscreen);
els.reset.addEventListener("click", resetApp);

["mousemove", "touchstart", "keydown"].forEach((ev) =>
  addEventListener(ev, bumpControls, { passive: true })
);

// double-click anywhere on the stage -> fullscreen
els.stage.addEventListener("dblclick", toggleFullscreen);

// main lyric clock
setInterval(tickLyrics, 80);

viz.init();
