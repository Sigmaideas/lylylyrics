/**
 * lylylyrics-proxy
 *
 * CORS proxy for NetEase (网易云音乐) synced lyrics. NetEase has strong Korean
 * coverage but sends no CORS headers, so the static site can't call it directly.
 *
 *   GET /netease?q=&artist=&track=&duration=
 *       -> { source, synced, syncedLyrics, plainLyrics, meta }  (404 if none)
 *
 * Returns the same shape as the LRCLIB responses the frontend already handles.
 */

const NE = "https://music.163.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=600",
      ...CORS,
    },
  });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/netease") return handleNetease(url);
    if (url.pathname === "/scene") return handleScene(url, env);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "lylylyrics-proxy" });
    }
    return json({ error: "not_found" }, 404);
  },
};

/* ---------- generative scene image (Workers AI) ---------- */
const STYLE =
  "cinematic wide establishing shot, filmic 35mm grain, moody atmospheric " +
  "lighting, muted retro color palette, dreamy, highly detailed, depth of " +
  "field, no text, no watermark, no faces";

// distinct "camera angles" so multiple variants of one song differ visually
const VARIANTS = [
  "wide establishing shot",
  "a different location within the same world, low angle, closer view",
  "a contrasting time of day (dawn/dusk/night) of the same setting",
  "a distant bird's-eye aerial view of the same world",
];

async function handleScene(url, env) {
  const title = (url.searchParams.get("title") || "").slice(0, 120);
  const artist = (url.searchParams.get("artist") || "").slice(0, 80);
  const variant = Math.max(0, Math.min(9, parseInt(url.searchParams.get("variant") || "0", 10)));
  const lyrics = (url.searchParams.get("lyrics") || "")
    .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500);

  const angle = VARIANTS[variant % VARIANTS.length];

  // 1) LLM turns the song into a vivid scene prompt matching its mood/genre
  let scene = "";
  try {
    const sys =
      "You convert a song into ONE vivid text-to-image prompt describing a " +
      "SCENE/PLACE/ATMOSPHERE that matches the song's mood and genre (e.g. " +
      "Korean city pop -> retro 1980s neon city skyline at night, rain-slick " +
      "streets; ballad -> quiet misty dawn; acoustic -> sunlit meadow). " +
      "No people, no text. Output ONLY the scene description, one concise " +
      "line, in English, max 40 words.";
    const user =
      `Title: ${title}\nArtist: ${artist}\nLyrics: ${lyrics}\n` +
      `Framing for this variant: ${angle}.`;
    const out = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 160,
      temperature: 0.9,
    });
    scene = (out.response || "").trim().replace(/^["'\s]+|["'\s]+$/g, "");
  } catch {
    scene = "";
  }
  if (!scene) scene = `${title} ${artist} mood, ${angle}, atmospheric scenery`;

  const prompt = `${scene}. ${STYLE}`;

  // 2) generate the image (Flux schnell — fast). Vary seed per variant.
  try {
    const img = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt,
      steps: 6,
      seed: 1000 + variant * 7919,
    });
    const bytes = Uint8Array.from(atob(img.image), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
        "x-scene": encodeURIComponent(scene),
        "access-control-expose-headers": "x-scene",
        ...CORS,
      },
    });
  } catch (e) {
    return json({ error: "image_failed", detail: String(e), scene }, 502);
  }
}

async function neFetch(target) {
  const r = await fetch(target, {
    headers: {
      "User-Agent": UA,
      Referer: "https://music.163.com",
      Cookie: "os=pc",
    },
  });
  if (!r.ok) throw new Error(`netease ${r.status}`);
  return r.json();
}

async function neSearch(q) {
  const d = await neFetch(
    `${NE}/api/search/get?type=1&limit=10&s=${encodeURIComponent(q)}`
  );
  return (d.result && d.result.songs) || [];
}

async function neLyric(id) {
  const d = await neFetch(`${NE}/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);
  return (d.lrc && d.lrc.lyric) || "";
}

const hasTimestamps = (lrc) => /\[\d{1,2}:\d{2}/.test(lrc);

async function handleNetease(url) {
  const q = (url.searchParams.get("q") || "").trim();
  const artist = (url.searchParams.get("artist") || "").trim();
  const track = (url.searchParams.get("track") || "").trim();
  const duration = parseInt(url.searchParams.get("duration") || "0", 10);

  const queries = [
    ...new Set(
      [q, `${artist} ${track}`, track].map((s) => (s || "").trim()).filter(Boolean)
    ),
  ];

  const seen = new Set();
  try {
    for (const query of queries) {
      let songs;
      try {
        songs = await neSearch(query);
      } catch {
        continue;
      }
      // prefer a duration match when we know it
      if (duration) {
        songs.sort(
          (a, b) =>
            Math.abs((a.duration || 0) / 1000 - duration) -
            Math.abs((b.duration || 0) / 1000 - duration)
        );
      }
      for (const s of songs.slice(0, 6)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        let lrc;
        try {
          lrc = await neLyric(s.id);
        } catch {
          continue;
        }
        if (lrc && hasTimestamps(lrc)) {
          return json({
            source: "netease",
            synced: true,
            plain: true,
            syncedLyrics: lrc,
            plainLyrics: "",
            meta: {
              trackName: s.name || "",
              artistName: (s.artists || []).map((a) => a.name).join(", "),
              duration: s.duration ? Math.round(s.duration / 1000) : null,
            },
          });
        }
      }
    }
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
  return json({ error: "not_found", synced: false }, 404);
}
