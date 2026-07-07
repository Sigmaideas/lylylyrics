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
async function fetchLyrics({ artist, track, author, duration }) {
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

  // 2) fuzzy search. Long titles (esp. with translated subtitles) miss on the
  //    full string, so try progressively shorter / more specific queries and
  //    keep the first hit that has synced lyrics.
  const words = (track || "").split(/\s+/).filter(Boolean);
  const noParen = (track || "")
    .replace(/[([{（【].*?[)\]}）】]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const candidates = [
    `${artist} ${track}`,
    track,
    noParen && noParen !== track ? `${artist} ${noParen}` : "",
    noParen && noParen !== track ? noParen : "",
    words.length > 6 ? words.slice(0, 6).join(" ") : "",
    words.length > 4 ? words.slice(0, 4).join(" ") : "",
    author && track && author !== artist ? `${author} ${track}` : "",
  ];

  const queries = [...new Set(candidates.map((s) => (s || "").trim()).filter(Boolean))];

  // Fire all candidate searches at once (LRCLIB is ~3s/request), then prefer a
  // synced hit from the earliest/most-specific query that matched.
  const hits = await Promise.all(
    queries.map(async (q) => {
      try {
        const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}`);
        if (!r.ok) return null;
        const arr = await r.json();
        if (!Array.isArray(arr) || !arr.length) return null;
        return arr.find((x) => x.syncedLyrics) || arr.find((x) => x.plainLyrics) || null;
      } catch {
        return null;
      }
    })
  );

  const best = hits.find((x) => x && x.syncedLyrics) || hits.find((x) => x && x.plainLyrics);
  if (best) return pick(best);

  // 3) LRCLIB missed — fall back to NetEase (via our proxy), which covers a lot
  //    of Korean / indie tracks LRCLIB doesn't have.
  return fetchNetease({ artist, track, duration });
}

const LYRICS_PROXY = "https://lylylyrics-proxy.sigmaidea.workers.dev";

async function fetchNetease({ artist, track, duration }) {
  try {
    const p = new URLSearchParams();
    if (artist) p.set("artist", artist);
    if (track) p.set("track", track);
    if (duration) p.set("duration", String(Math.round(duration)));
    p.set("q", `${artist} ${track}`.trim());
    const r = await fetch(`${LYRICS_PROXY}/netease?${p}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d && (d.syncedLyrics || d.plainLyrics)) {
      return { syncedLyrics: d.syncedLyrics || "", plainLyrics: d.plainLyrics || "" };
    }
  } catch {
    /* proxy unreachable — stay silent, caller shows "not found" */
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
  let author = ""; // raw oEmbed channel name, used as an extra search fallback
  if (!artist || !track) {
    const meta = await fetchMeta(videoUrl);
    if (meta && meta.title) {
      const g = guessArtistTrack(meta.title, meta.author);
      artist = artist || g.artist;
      track = track || g.track;
      author = meta.author || "";
    }
  }
  state.meta = { artist, track, author };

  // 2) start the player (user gesture -> autoplay with sound allowed)
  setStatus("플레이어 준비 중…");
  await ytReady;
  await createPlayer(videoId);
  const duration = safeDuration();

  // 3) reveal the stage IMMEDIATELY — music is already playing. Lyrics load in
  //    the background so a slow/failed search never leaves the user on a spinner.
  els.start.classList.add("hidden");
  els.stage.classList.remove("hidden");
  els.nowPlaying.textContent = [artist, track].filter(Boolean).join(" — ");
  els.trackInfo.textContent = [artist, track].filter(Boolean).join(" — ");
  setInstrumental(true); // abstract visuals until (or unless) lyrics arrive
  noteCaption = ""; // still searching — just ♪, no "not found" yet
  paintInitial();
  bumpControls();
  els.go.disabled = false;
  setStatus("");

  // 4) lyrics (background)
  fetchLyrics({ artist, track, author, duration })
    .then((data) => applyLyrics(data, duration))
    .catch(() => applyLyrics(null, duration));
}

function setInstrumental(on) {
  state.instrumental = on;
  document.body.classList.toggle("instrumental", on);
}

function applyLyrics(data, duration) {
  state.lines = [];
  state.index = -1;
  state.hasSynced = false;

  if (data && data.syncedLyrics) {
    state.lines = parseLRC(data.syncedLyrics);
    state.hasSynced = state.lines.length > 0;
  }
  if (!state.lines.length && data && data.plainLyrics) {
    state.lines = estimateTiming(data.plainLyrics, duration);
  }

  setInstrumental(state.lines.length === 0);
  // if we searched and truly found nothing, say so instead of a bare ♪
  noteCaption = state.lines.length === 0 ? "이 곡의 가사를 찾지 못했어요" : "";
  paintInitial(); // initial paint
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
    showComposition(idx);
    viz.pulse(); // surge the visualization on each new line
  }
}

/* ------------------------------------------------------------------ *
 * Lyric rendering — Cotodama-style scattered composition.
 * On each new line we lay out the current line (hero) plus the previous and
 * next lines as smaller, tilted fragments at varied positions, then animate
 * the whole set in; the old set animates out. Fonts, sizes, angles, positions
 * and the single accent colour are picked deterministically per line so the
 * composition keeps changing but never turns to noise.
 * ------------------------------------------------------------------ */
function lineText(i) {
  return i >= 0 && i < state.lines.length ? state.lines[i].text : "";
}

// single gothic font (Pretendard) — vary weight instead of family
const HERO_WEIGHT = ["w-thin", "w-bold", "w-mid", "w-bold", "w-thin"];
// continuous-motion styles
const MOTION_HERO = ["m-zin", "m-zout", "m-sway"];
const MOTION_SEC = ["m-sway", "m-orbit", "m-pulse", "m-zin"];
// deterministic per-line pick, decorrelated per attribute
const pk = (i, mul, add, len) => (((i * mul + add) % len) + len) % len;

// composition templates: placement of [hero, next, prev] fragments.
// x/y are viewport %, rot in degrees (occasionally ~180 for flipped text).
const LAYOUTS = [
  { hero: { x: 48, y: 44, rot: -4, align: "center" }, next: { x: 73, y: 20, rot: 6, align: "left" },    prev: { x: 64, y: 80, rot: -177, align: "left" } },
  { hero: { x: 50, y: 53, rot: 3, align: "center" },  next: { x: 24, y: 24, rot: -8, align: "left" },   prev: { x: 74, y: 82, rot: 3, align: "right" } },
  { hero: { x: 47, y: 41, rot: 0, align: "center" },  next: { x: 28, y: 75, rot: 5, align: "left" },    prev: { x: 76, y: 22, rot: 183, align: "left" } },
  { hero: { x: 46, y: 57, rot: 4, align: "center" },  next: { x: 72, y: 36, rot: -4, align: "left" },   prev: { x: 30, y: 18, rot: -6, align: "left" } },
  { hero: { x: 52, y: 47, rot: -5, align: "center" }, next: { x: 28, y: 66, rot: 4, align: "left" },    prev: { x: 34, y: 22, rot: 178, align: "left" } },
  { hero: { x: 48, y: 50, rot: -3, align: "center" }, next: { x: 75, y: 73, rot: 8, align: "left" },    prev: { x: 20, y: 30, rot: -4, align: "left" } },
];
// hero colour cycle: mostly white, occasional accent, occasional outline
const HERO_COLOR = ["c-hero", "c-hero", "c-accent", "c-outline", "c-hero"];

let activeFrags = [];
let shownIdx = -2;
let noteCaption = ""; // shown under ♪ when a search finished with no lyrics

function makeFrag(text, spec, { role, color, weight, size, motion }) {
  const el = document.createElement("div");
  el.className = ["frag", role === "hero" ? "hero" : "", size, color, weight, motion]
    .filter(Boolean)
    .join(" ");
  el.style.setProperty("--x", spec.x + "%");
  el.style.setProperty("--y", spec.y + "%");
  el.style.setProperty("--rot", spec.rot + "deg");
  el.style.setProperty("--align", spec.align);

  // .frag > .inner (entrance/exit) > .motion (continuous zoom/rotate/drift)
  const inner = document.createElement("span");
  inner.className = "inner";
  const mo = document.createElement("span");
  mo.className = "motion";

  if (role === "hero") {
    // character-by-character reveal
    const chars = [...text];
    const stagger = Math.min(55, 620 / Math.max(1, chars.length));
    let ci = 0;
    for (const ch of chars) {
      if (ch === " ") {
        mo.appendChild(document.createTextNode(" "));
        continue;
      }
      const s = document.createElement("span");
      s.className = "c";
      s.textContent = ch;
      s.style.animationDelay = Math.round(ci * stagger) + "ms";
      mo.appendChild(s);
      ci++;
    }
  } else {
    mo.textContent = text;
  }
  inner.appendChild(mo);
  el.appendChild(inner);
  return el;
}

function retireFrags() {
  for (const el of activeFrags) {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 800); // safety net
  }
  activeFrags = [];
}

function buildNote() {
  const el = document.createElement("div");
  el.className = "frag note s-xl c-dim";
  el.style.setProperty("--x", "50%");
  el.style.setProperty("--y", noteCaption ? "44%" : "48%");
  el.style.setProperty("--rot", "0deg");
  el.style.setProperty("--align", "center");
  const inner = document.createElement("span");
  inner.className = "inner";
  inner.textContent = "♪";
  el.appendChild(inner);
  els.lyrics.appendChild(el);
  activeFrags.push(el);

  if (noteCaption) {
    const cap = document.createElement("div");
    cap.className = "frag s-s c-dim";
    cap.style.setProperty("--x", "50%");
    cap.style.setProperty("--y", "60%");
    cap.style.setProperty("--rot", "0deg");
    cap.style.setProperty("--align", "center");
    const ci = document.createElement("span");
    ci.className = "inner";
    const cm = document.createElement("span");
    cm.className = "motion";
    cm.textContent = noteCaption;
    ci.appendChild(cm);
    cap.appendChild(ci);
    els.lyrics.appendChild(cap);
    activeFrags.push(cap);
  }
}

function showComposition(i) {
  if (i === shownIdx) return;
  shownIdx = i;
  retireFrags();

  const hero = lineText(i);
  if (!hero) {
    buildNote(); // intro (before first line) or instrumental
    return;
  }

  const L = LAYOUTS[pk(i, 1, 0, LAYOUTS.length)];
  const heroSize = [...hero].length > 16 ? "s-l" : "s-xl";

  // hero (current line)
  activeFrags.push(
    makeFrag(hero, L.hero, {
      role: "hero",
      color: HERO_COLOR[pk(i, 1, 0, HERO_COLOR.length)],
      weight: HERO_WEIGHT[pk(i, 1, 0, HERO_WEIGHT.length)],
      size: heroSize,
      motion: MOTION_HERO[pk(i, 2, 0, MOTION_HERO.length)],
    })
  );
  // next line (secondary)
  const next = lineText(i + 1);
  if (next) {
    activeFrags.push(
      makeFrag(next, L.next, {
        role: "sec",
        color: "c-dim",
        weight: "w-mid",
        size: "s-m",
        motion: MOTION_SEC[pk(i, 3, 1, MOTION_SEC.length)],
      })
    );
  }
  // previous line (tertiary)
  const prev = lineText(i - 1);
  if (prev) {
    activeFrags.push(
      makeFrag(prev, L.prev, {
        role: "sec",
        color: "c-dim",
        weight: "w-thin",
        size: "s-s",
        motion: MOTION_SEC[pk(i, 5, 3, MOTION_SEC.length)],
      })
    );
  }

  for (const el of activeFrags) els.lyrics.appendChild(el);
}

function clearLines() {
  els.lyrics.innerHTML = "";
  activeFrags = [];
  shownIdx = -2;
}

// initial paint: instrumental -> ♪; otherwise intro note until the first line
function paintInitial() {
  clearLines();
  state.index = -1;
  showComposition(-1); // hero text empty -> ♪ intro
}

/* ------------------------------------------------------------------ *
 * Visualization — cyber node-graph network: drifting nodes connected by
 * lines when close (a constellation / neural-net structure). A lyric change
 * sends an energy shock that brightens edges, enlarges nodes and radiates
 * an expanding ring. Monochrome with an occasional accent node.
 * ------------------------------------------------------------------ */
const viz = (() => {
  const canvas = $("viz");
  const ctx = canvas.getContext("2d");
  let w = 0,
    h = 0,
    dpr = 1;
  let energy = 0; // decays; bumped on each lyric line
  const nodes = [];
  const rings = []; // expanding pulse rings
  let linkDist = 160;

  const ink = (a) => `rgba(244,242,238,${a})`;
  const acc = (a) => `rgba(255,59,48,${a})`;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(innerWidth * dpr);
    h = canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    linkDist = Math.min(w, h) * 0.16;
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function initNodes() {
    nodes.length = 0;
    const count = Math.min(120, Math.round((innerWidth * innerHeight) / 17000));
    for (let i = 0; i < count; i++) {
      nodes.push({
        x: rand(0, w),
        y: rand(0, h),
        vx: rand(-0.22, 0.22) * dpr,
        vy: rand(-0.22, 0.22) * dpr,
        r: rand(1.1, 2.4) * dpr,
        hub: Math.random() < 0.12, // brighter "hub" nodes
        accent: Math.random() < 0.06, // rare accent node
      });
    }
  }

  function pulse() {
    energy = Math.min(1.6, energy + 1);
    rings.push({ r: Math.min(w, h) * 0.04, a: 0.55 });
    if (rings.length > 6) rings.shift();
  }

  function frame() {
    energy *= 0.94;

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#060606";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2,
      cy = h / 2,
      base = Math.min(w, h);
    const speed = 1 + energy * 1.6;
    const dist = linkDist * (1 + energy * 0.15);

    // move nodes (bounce off edges)
    for (const n of nodes) {
      n.x += n.vx * speed;
      n.y += n.vy * speed;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
      n.x = Math.max(0, Math.min(w, n.x));
      n.y = Math.max(0, Math.min(h, n.y));
    }

    // edges between nearby nodes
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x,
          dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > dist * dist) continue;
        const t = 1 - Math.sqrt(d2) / dist;
        const alpha = t * (0.12 + energy * 0.22);
        ctx.strokeStyle = a.accent || b.accent ? acc(alpha) : ink(alpha);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // nodes
    for (const n of nodes) {
      const rr = n.r * (n.hub ? 1.8 : 1) * (1 + energy * 0.6);
      ctx.fillStyle = n.accent
        ? acc(0.5 + energy * 0.4)
        : ink((n.hub ? 0.5 : 0.28) + energy * 0.3);
      ctx.beginPath();
      ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    // expanding shock rings from center on each pulse
    for (let i = rings.length - 1; i >= 0; i--) {
      const rg = rings[i];
      rg.r += base * 0.014;
      rg.a *= 0.94;
      if (rg.a < 0.02) {
        rings.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = ink(rg.a * 0.4);
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, rg.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    requestAnimationFrame(frame);
  }

  function init() {
    resize();
    initNodes();
    requestAnimationFrame(frame);
    addEventListener("resize", () => {
      resize();
      initNodes();
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
  clearLines();
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
