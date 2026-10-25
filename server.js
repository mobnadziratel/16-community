const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const PUBLIC_DIR = path.join(__dirname, "public");

const LOGINS = [
  "mob_nadziratel",
  "d1unizi",
  "plovecmolodec",
  "charakoi",
  "kerik232tv",
  "ribafyga",
  "mrbatosh",
  "roman16rus",
  "rueumur",
  "cherrys_fox",
  "hdr_straiker",
  "kostyan_321r",
  "sayjos",
  "lo4kalove",
  "slavabraze",
  "zavryz1el",
  "ilyuha_lake",
  "brill1antt",
  "helgard_simbirskiy",
  "pickachu2281",
  "zane5k5",
  "dima26rx",
  "ishak_kodolov",
  "mandarin555q"
];

let token = null;
let tokenExpiresAt = 0;
let cachedStreams = {};
let cacheExpiresAt = 0;
let refreshInFlight = null;

async function getAppToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "client_credentials"
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Twitch token request failed (${response.status})`);
  const data = await response.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return token;
}

async function fetchStreams() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in the environment.");
  }
  const accessToken = await getAppToken();
  const params = new URLSearchParams();
  LOGINS.forEach(login => params.append("user_login", login));
  const response = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: {
      "Client-Id": CLIENT_ID,
      "Authorization": `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    if (response.status === 401) {
      token = null;
      tokenExpiresAt = 0;
    }
    throw new Error(`Twitch streams request failed (${response.status})`);
  }
  const data = await response.json();
  const result = {};
  LOGINS.forEach(login => {
    result[login] = { isLive: false, viewerCount: null, title: null };
  });
  (data.data || []).forEach(stream => {
    const login = String(stream.user_login || "").toLowerCase();
    if (result[login]) {
      result[login] = {
        isLive: true,
        viewerCount: Number(stream.viewer_count || 0),
        title: String(stream.title || ""),
        startedAt: String(stream.started_at || "")
      };
    }
  });
  cachedStreams = result;
  cacheExpiresAt = Date.now() + 30_000;
  return result;
}

async function getStreams() {
  if (Date.now() < cacheExpiresAt) return cachedStreams;
  if (!refreshInFlight) {
    refreshInFlight = fetchStreams().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}


let clipsCache = new Map();
const avatarCache = new Map();
const followerCountCache = new Map();
const followerCountInFlight = new Map();
async function helix(pathname, params) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in Render environment.");
  const accessToken = await getAppToken();
  const response = await fetch(`https://api.twitch.tv/helix/${pathname}?${params.toString()}`, {
    headers: { "Client-Id": CLIENT_ID, "Authorization": `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    if (response.status === 401) { token = null; tokenExpiresAt = 0; }
    throw new Error(`Twitch ${pathname} request failed (${response.status})`);
  }
  return response.json();
}
async function fetchFollowerCount(login) {
  const now = Date.now();
  const cached = followerCountCache.get(login);
  if (cached && now - cached.fetchedAt < 2 * 60_000) return cached.result;
  if (followerCountInFlight.has(login)) return followerCountInFlight.get(login);

  const request = (async () => {
    const response = await fetch(`https://decapi.me/twitch/followcount/${encodeURIComponent(login)}`, {
      headers: { "Accept": "text/plain", "User-Agent": "SmallStreamersDirectory/1.0" },
      signal: AbortSignal.timeout(8000)
    });
    const raw = (await response.text()).trim();
    // DecAPI returns the public follower total as plain text. Reject error messages rather than displaying them as counts.
    const normalized = raw.replace(/[\s,]/g, "");
    if (!response.ok || !/^\d+$/.test(normalized)) {
      throw new Error(`Follower count provider returned an invalid response (${response.status})`);
    }
    const total = Number(normalized);
    const result = { login, total, updatedAt: new Date().toISOString() };
    followerCountCache.set(login, { result, fetchedAt: Date.now() });
    return result;
  })().finally(() => followerCountInFlight.delete(login));

  followerCountInFlight.set(login, request);
  return request;
}
async function fetchClips(period) {
  const now = Date.now();
  const cacheKey = period;
  const cached = clipsCache.get(cacheKey);
  if (cached && now - cached.time < 5 * 60_000) return cached.clips;

  const userParams = new URLSearchParams();
  LOGINS.forEach(login => userParams.append("login", login));
  const usersPayload = await helix("users", userParams);
  const users = usersPayload.data || [];
  if (!users.length) throw new Error("Twitch API не вернул ни одного канала для списка клипов.");

  const hoursByPeriod = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30, "365d": 24 * 365 };
  const cutoffHours = hoursByPeriod[period] || 0;
  const endedAt = new Date(now).toISOString();
  const startedAt = cutoffHours ? new Date(now - cutoffHours * 60 * 60 * 1000).toISOString() : null;
  const queue = users.slice();
  const all = [];
  let failedChannels = 0;

  // Keep API traffic modest: at most 3 pages (300 clips) per channel per refresh.
  // One failing channel must not prevent clips from all other channels from loading.
  async function worker() {
    while (queue.length) {
      const user = queue.shift();
      let cursor = null;
      for (let page = 0; page < 3; page++) {
        const params = new URLSearchParams({ broadcaster_id: user.id, first: "100" });
        if (startedAt) {
          params.set("started_at", startedAt);
          params.set("ended_at", endedAt);
        }
        if (cursor) params.set("after", cursor);
        try {
          const payload = await helix("clips", params);
          const pageClips = payload.data || [];
          all.push(...pageClips);
          cursor = payload.pagination && payload.pagination.cursor;
          if (!cursor || pageClips.length === 0) break;
        } catch (error) {
          failedChannels++;
          console.error(`Could not load clips for ${user.login}: ${error.message}`);
          break;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  if (!all.length && failedChannels > 0) {
    throw new Error(`Twitch не вернул клипы: запросы к каналам завершились ошибкой (${failedChannels} неудачных запросов).`);
  }
  const clips = all.map(clip => ({
    id: clip.id,
    url: clip.url,
    title: clip.title,
    viewCount: Number(clip.view_count || 0),
    createdAt: clip.created_at,
    thumbnailUrl: clip.thumbnail_url,
    broadcasterName: clip.broadcaster_name,
    broadcasterLogin: clip.broadcaster_login || clip.broadcaster_name
  }));
  clipsCache.set(cacheKey, { time: now, clips });
  return clips;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/followers") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const login = String(url.searchParams.get("login") || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) {
      res.writeHead(400); res.end(JSON.stringify({ error: "Invalid Twitch login", total: null })); return;
    }
    try {
      const result = await fetchFollowerCount(login);
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch (error) {
      console.error(`Could not load follower total for ${login}: ${error.message}`);
      res.writeHead(503); res.end(JSON.stringify({ error: "Twitch follower count is temporarily unavailable", total: null }));
    }
    return;
  }

  if (url.pathname === "/api/avatar") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    const login = String(url.searchParams.get("login") || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) {
      res.writeHead(400); res.end(JSON.stringify({ error: "Invalid Twitch login", avatarUrl: null })); return;
    }
    const cached = avatarCache.get(login);
    if (cached && Date.now() - cached.time < 30 * 60_000) {
      res.writeHead(200); res.end(JSON.stringify({ login, avatarUrl: cached.avatarUrl })); return;
    }
    try {
      const params = new URLSearchParams(); params.append("login", login);
      const payload = await helix("users", params);
      const avatarUrl = payload.data && payload.data[0] && payload.data[0].profile_image_url;
      if (!avatarUrl) { res.writeHead(404); res.end(JSON.stringify({ error: "Twitch user not found", avatarUrl: null })); return; }
      avatarCache.set(login, { time: Date.now(), avatarUrl });
      res.writeHead(200); res.end(JSON.stringify({ login, avatarUrl }));
    } catch (error) {
      console.error(`Could not load avatar for ${login}: ${error.message}`);
      res.writeHead(503); res.end(JSON.stringify({ error: "Avatar temporarily unavailable", avatarUrl: null }));
    }
    return;
  }

  if (url.pathname === "/api/clips") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const allowed = new Set(["24h", "7d", "30d", "365d", "all"]);
      const period = allowed.has(url.searchParams.get("period")) ? url.searchParams.get("period") : "all";
      const clips = await fetchClips(period);
      res.writeHead(200); res.end(JSON.stringify({ updatedAt: new Date().toISOString(), clips }));
    } catch (error) {
      console.error(error.message);
      res.writeHead(503); res.end(JSON.stringify({ error: error.message || "Twitch clips are temporarily unavailable", clips: [] }));
    }
    return;
  }

  if (url.pathname === "/api/streams") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "same-origin");
    try {
      const streams = await getStreams();
      res.writeHead(200);
      res.end(JSON.stringify({ updatedAt: new Date().toISOString(), streams }));
    } catch (error) {
      console.error(error.message);
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Twitch status is temporarily unavailable", streams: {} }));
    }
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`1°6 Community running at http://localhost:${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn("Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET. Live statuses will not work until configured.");
  }
});
