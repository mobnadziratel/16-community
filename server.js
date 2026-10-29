const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

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
  "dima26rx1",
  "ishak_kodolov",
  "mandarin555q",
  "z3kat",
  "ssh1nxx",
  "homka20_",
  "medverina",
  "ne_twig",
  "screada67",
  "alicefagg"
];

let token = null;
let tokenExpiresAt = 0;
let cachedStreams = {};
let cacheExpiresAt = 0;
let refreshInFlight = null;
let twitchDiagnosticsCache = null;
let twitchDiagnosticsExpiresAt = 0;
let twitchDiagnosticsInFlight = null;

async function getTwitchDiagnostics() {
  if (twitchDiagnosticsCache && Date.now() < twitchDiagnosticsExpiresAt) return twitchDiagnosticsCache;
  if (twitchDiagnosticsInFlight) return twitchDiagnosticsInFlight;
  twitchDiagnosticsInFlight = (async () => {
    const report = {
      checkedAt: new Date().toISOString(),
      environment: {
        clientIdConfigured: Boolean(CLIENT_ID),
        clientSecretConfigured: Boolean(CLIENT_SECRET)
      },
      authentication: { ok: false },
      userLookup: { ok: false, found: false },
      streamByLogin: { ok: false, isLive: false },
      streamByUserId: { ok: false, isLive: false }
    };
    if (!CLIENT_ID || !CLIENT_SECRET) {
      report.authentication.error = "Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in Render Environment.";
      return report;
    }
    let accessToken;
    try {
      accessToken = await getAppToken();
      report.authentication = { ok: true };
    } catch (error) {
      report.authentication = { ok: false, error: error.message };
      return report;
    }

    async function queryHelix(endpoint, params) {
      try {
        const response = await fetch(`https://api.twitch.tv/helix/${endpoint}?${params}`, {
          headers: { "Client-Id": CLIENT_ID, "Authorization": `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) return { ok: false, status: response.status };
        return { ok: true, data: await response.json() };
      } catch (error) {
        return { ok: false, error: error.name === "TimeoutError" ? "Request timed out" : error.message };
      }
    }

    const userResult = await queryHelix("users", new URLSearchParams({ login: "z3kat" }));
    report.userLookup.ok = userResult.ok;
    if (!userResult.ok) {
      Object.assign(report.userLookup, { status: userResult.status, error: userResult.error });
      return report;
    }
    const user = (userResult.data.data || [])[0];
    report.userLookup.found = Boolean(user);
    if (!user) return report;
    report.userLookup.login = user.login;
    report.userLookup.displayName = user.display_name;
    report.userLookup.userId = user.id;

    const byLogin = await queryHelix("streams", new URLSearchParams({ user_login: String(user.login || "z3kat").toLowerCase() }));
    report.streamByLogin.ok = byLogin.ok;
    if (!byLogin.ok) Object.assign(report.streamByLogin, { status: byLogin.status, error: byLogin.error });
    else {
      const stream = (byLogin.data.data || [])[0];
      report.streamByLogin.isLive = Boolean(stream);
      if (stream) Object.assign(report.streamByLogin, { title: stream.title, viewerCount: Number(stream.viewer_count || 0) });
    }

    const byId = await queryHelix("streams", new URLSearchParams({ user_id: String(user.id) }));
    report.streamByUserId.ok = byId.ok;
    if (!byId.ok) Object.assign(report.streamByUserId, { status: byId.status, error: byId.error });
    else {
      const stream = (byId.data.data || [])[0];
      report.streamByUserId.isLive = Boolean(stream);
      if (stream) Object.assign(report.streamByUserId, { title: stream.title, viewerCount: Number(stream.viewer_count || 0) });
    }
    return report;
  })().then(report => {
    twitchDiagnosticsCache = report;
    twitchDiagnosticsExpiresAt = Date.now() + 30_000;
    return report;
  }).finally(() => { twitchDiagnosticsInFlight = null; });
  return twitchDiagnosticsInFlight;
}

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
    body,
    signal: AbortSignal.timeout(12000)
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
    },
    signal: AbortSignal.timeout(12000)
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

  // Focused fallback for Z3KAT. Resolve the canonical Twitch user first, then
  // verify the stream by both login and stable user ID. A missing stream entry
  // in Helix means offline; a failed lookup is logged and never treated as proof.
  if (!result.z3kat?.isLive) {
    try {
      const userParams = new URLSearchParams({ login: "z3kat" });
      const userResponse = await fetch(`https://api.twitch.tv/helix/users?${userParams}`, {
        headers: { "Client-Id": CLIENT_ID, "Authorization": `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });
      if (!userResponse.ok) throw new Error(`users lookup HTTP ${userResponse.status}`);
      const userData = await userResponse.json();
      const twitchUser = (userData.data || [])[0];

      if (!twitchUser) {
        console.warn("Twitch users lookup did not resolve login z3kat; check whether the channel username changed.");
      } else {
        const canonicalLogin = String(twitchUser.login || "z3kat").toLowerCase();
        const singleQueries = [
          { label: "login", params: new URLSearchParams({ user_login: canonicalLogin }) },
          { label: "user_id", params: new URLSearchParams({ user_id: String(twitchUser.id) }) }
        ];
        for (const query of singleQueries) {
          const singleResponse = await fetch(`https://api.twitch.tv/helix/streams?${query.params}`, {
            headers: { "Client-Id": CLIENT_ID, "Authorization": `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(8000)
          });
          if (!singleResponse.ok) {
            console.error(`Focused Z3KAT ${query.label} lookup failed (HTTP ${singleResponse.status})`);
            continue;
          }
          const singleData = await singleResponse.json();
          const stream = (singleData.data || []).find(item =>
            String(item.user_id || "") === String(twitchUser.id) ||
            String(item.user_login || "").toLowerCase() === canonicalLogin
          );
          if (stream) {
            result.z3kat = {
              isLive: true,
              viewerCount: Number(stream.viewer_count || 0),
              title: String(stream.title || ""),
              startedAt: String(stream.started_at || ""),
              userLogin: canonicalLogin
            };
            break;
          }
        }
        if (!result.z3kat?.isLive) {
          console.info(`Twitch confirms no live stream for Z3KAT (${canonicalLogin}, user id ${twitchUser.id}) at ${new Date().toISOString()}.`);
        }
      }
    } catch (error) {
      // Do not silently assume that a failed fallback means the channel is offline.
      console.error(`Focused Z3KAT status lookup failed: ${error.message}`);
    }
  }

  cachedStreams = result;
  cacheExpiresAt = Date.now() + 30_000;
  return result;
}

let collabCache = {};
let collabCacheAt = 0;
async function getCollaborations() {
  if (Date.now() - collabCacheAt < 60000) return collabCache;
  const live = await getStreams();
  const logins = LOGINS.filter(login => live[login] && live[login].isLive);
  if (!logins.length) { collabCache = {}; collabCacheAt = Date.now(); return collabCache; }
  const params = new URLSearchParams();
  LOGINS.forEach(login => params.append("login", login));
  const userData = await helix("users", params);
  const users = userData.data || [];
  const byLogin = new Map(users.map(user => [String(user.login).toLowerCase(), user]));
  const byId = new Map(users.map(user => [String(user.id), user]));
  const result = {};
  for (const login of logins) {
    const user = byLogin.get(login);
    if (!user) continue;
    try {
      const data = await helix("shared_chat/session", new URLSearchParams({ broadcaster_id: String(user.id) }));
      const session = (data.data || [])[0];
      if (!session || !Array.isArray(session.participants) || session.participants.length < 2) continue;
      const ids = session.participants.map(p => String(p.broadcaster_id));
      const missing = ids.filter(id => !byId.has(id));
      if (missing.length) {
        const extraParams = new URLSearchParams();
        missing.forEach(id => extraParams.append("id", id));
        const extra = await helix("users", extraParams);
        (extra.data || []).forEach(u => byId.set(String(u.id), u));
      }
      const participants = ids.map(id => byId.get(id)).filter(Boolean).map(u => ({ login: String(u.login).toLowerCase(), displayName: String(u.display_name || u.login) }));
      if (participants.length > 1) result[login] = { participants: participants.filter(p => p.login !== login) };
    } catch (error) {
      console.warn("Twitch shared-chat lookup failed for " + login + ": " + error.message);
    }
  }
  collabCache = result;
  collabCacheAt = Date.now();
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
    headers: { "Client-Id": CLIENT_ID, "Authorization": `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12000)
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

  // Limit each channel to one page per refresh. The browser renders results in
  // small batches, so returning thousands of cards at once is unnecessary.
  async function worker() {
    while (queue.length) {
      const user = queue.shift();
      let cursor = null;
      for (let page = 0; page < 1; page++) {
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
    broadcasterLogin: clip.broadcaster_login || clip.broadcaster_name,
    creatorName: clip.creator_name || "",
    creatorLogin: clip.creator_name || ""
  }));
  clipsCache.set(cacheKey, { time: now, clips });
  return clips;
}



const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
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

  if (url.pathname === "/api/chat-colors") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    const logins = [...new Set(String(url.searchParams.get("logins") || "")
      .split(",").map(value => value.trim().toLowerCase()).filter(value => /^[a-z0-9_]{1,25}$/.test(value)))].slice(0, 100);
    if (!logins.length) { res.writeHead(200); res.end(JSON.stringify({ colors: {} })); return; }
    try {
      const usersParams = new URLSearchParams();
      for (const login of logins) usersParams.append("login", login);
      const usersPayload = await helix("users", usersParams);
      const users = usersPayload.data || [];
      const colorParams = new URLSearchParams();
      for (const user of users) colorParams.append("user_id", String(user.id));
      const colorsPayload = users.length ? await helix("chat/color", colorParams) : { data: [] };
      const colors = {};
      for (const item of colorsPayload.data || []) {
        if (item.color) colors[String(item.user_login || "").toLowerCase()] = item.color;
      }
      res.writeHead(200); res.end(JSON.stringify({ colors }));
    } catch (error) {
      console.error("Could not load Twitch chat colors: " + error.message);
      res.writeHead(503); res.end(JSON.stringify({ error: "Twitch chat colors temporarily unavailable", colors: {} }));
    }
    return;
  }

  if (url.pathname === "/api/chat-badges") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=1800");
    try {
      const globalPayload = await helix("chat/badges/global", new URLSearchParams());
      const sets = [...(globalPayload.data || [])];
      const channelLogin = String(url.searchParams.get("channel") || "").trim().toLowerCase();
      if (channelLogin && /^[a-z0-9_]{1,25}$/.test(channelLogin)) {
        const userParams = new URLSearchParams(); userParams.append("login", channelLogin);
        const userPayload = await helix("users", userParams);
        const broadcaster = (userPayload.data || [])[0];
        if (broadcaster) {
          const badgeParams = new URLSearchParams({ broadcaster_id: String(broadcaster.id) });
          const channelPayload = await helix("chat/badges", badgeParams);
          sets.push(...(channelPayload.data || []));
        }
      }
      const badges = {};
      for (const set of sets) {
        const versions = (set.versions || []).map(version => ({
          id: String(version.id),
          title: version.title || set.set_id,
          url: version.image_url_2x || version.image_url_1x || ""
        })).filter(version => version.url);
        if (versions.length) badges[set.set_id] = { title: set.set_id, versions };
      }
      res.writeHead(200); res.end(JSON.stringify({ badges }));
    } catch (error) {
      console.error("Could not load official Twitch chat badges: " + error.message);
      res.writeHead(503); res.end(JSON.stringify({ error: "Twitch badges temporarily unavailable", badges: {} }));
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
    const forceRefresh = url.searchParams.get("refresh") === "1" || login === "ilyuha_lake";
    const cached = avatarCache.get(login);
    if (!forceRefresh && cached && Date.now() - cached.time < 30 * 60_000) {
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

  if (url.pathname === "/api/diagnostics/twitch") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const diagnostics = await getTwitchDiagnostics();
      res.writeHead(200);
      res.end(JSON.stringify(diagnostics));
    } catch (error) {
      console.error(`Twitch diagnostics failed: ${error.message}`);
      res.writeHead(503);
      res.end(JSON.stringify({ checkedAt: new Date().toISOString(), error: "Diagnostic request failed" }));
    }
    return;
  }

  if (url.pathname === "/api/collaborations") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      res.writeHead(200);
      res.end(JSON.stringify({ collaborations: await getCollaborations() }));
    } catch (error) {
      console.error("Twitch collaborations unavailable: " + error.message);
      res.writeHead(503);
      res.end(JSON.stringify({ collaborations: {}, error: "unavailable" }));
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





  if (url.pathname.startsWith("/api/music/")) {
    const json=(status,payload,headers={})=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers});res.end(JSON.stringify(payload))};
    const clean=(v,n)=>String(v||"").replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,n),channelName=v=>{const s=clean(v,25).replace(/^@/,"").toLowerCase();return /^[a-z0-9_]{1,25}$/.test(s)?s:""};
    async function bodyJson(limit=20480){const a=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error("Запрос слишком большой."),{statusCode:413});a.push(chunk)}try{return a.length?JSON.parse(Buffer.concat(a).toString("utf8")):{}}catch{throw Object.assign(Error("Некорректный JSON."),{statusCode:400})}}
    async function bodyText(body){const a=[];for await(const chunk of body)a.push(Buffer.from(chunk));return Buffer.concat(a).toString("utf8")}
    const dir=process.env.WALL_DATA_DIR||path.join(__dirname,"data"),file=path.join(dir,"music-queue.json"),aid=process.env.R2_ACCOUNT_ID,bucket=process.env.R2_BUCKET_NAME,enabled=Boolean(aid&&bucket&&process.env.R2_ACCESS_KEY_ID&&process.env.R2_SECRET_ACCESS_KEY),r2=enabled?new S3Client({region:"auto",endpoint:process.env.R2_ENDPOINT||("https://"+aid+".r2.cloudflarestorage.com"),credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}}):null,key=process.env.MUSIC_R2_OBJECT_KEY||"music-queue.json";
    async function localRead(){await fs.promises.mkdir(dir,{recursive:true});try{const d=JSON.parse(await fs.promises.readFile(file,"utf8"));return{items:Array.isArray(d.items)?d.items:[]}}catch(e){if(e.code==="ENOENT")return{items:[]};throw e}}
    async function load(){if(!enabled)return localRead();let shared;try{const o=await r2.send(new GetObjectCommand({Bucket:bucket,Key:key})),d=JSON.parse(await bodyText(o.Body));shared={items:Array.isArray(d.items)?d.items:[]}}catch(e){if(e.name==="NoSuchKey"||e.Code==="NoSuchKey"||e.$metadata?.httpStatusCode===404)shared={items:[]};else throw Error("Не удалось прочитать очередь музыки.")}const local=await localRead(),known=new Set(shared.items.filter(x=>x&&x.id).map(x=>String(x.id))),missing=local.items.filter(x=>x&&typeof x==="object"&&x.id&&!known.has(String(x.id)));if(missing.length){shared.items.push(...missing);await save(shared)}return shared}
    async function save(db){const data=JSON.stringify(db,null,2);if(enabled){await r2.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:data,ContentType:"application/json"}));return}await fs.promises.mkdir(dir,{recursive:true});const tmp=file+".tmp";await fs.promises.writeFile(tmp,data,{mode:0o600});await fs.promises.rename(tmp,file)}
    function normalizeMusicQueue(db,ch,promoteIfEmpty=false){let changed=false;const active=db.items.filter(x=>x&&x.channel===ch&&["pending","playing"].includes(x.status)).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||""))),playing=active.filter(x=>x.status==="playing");for(const duplicate of playing.slice(1)){duplicate.status="pending";changed=true}if(promoteIfEmpty&&playing.length===0){const next=active.find(x=>x.status==="pending");if(next){next.status="playing";changed=true}}return changed}
    const sessions=globalThis.__musicSessions||(globalThis.__musicSessions=new Map()),cookie=String(req.headers.cookie||"").split(";").map(v=>v.trim()).find(v=>v.startsWith("music_admin_session=")),sessionId=cookie?cookie.slice("music_admin_session=".length):"",session=sessions.get(sessionId),isAdmin=Boolean(session&&session.expiresAt>Date.now()),method=req.method||"GET";
    try{
      if(url.pathname==="/api/music/admin/session"&&method==="GET"){if(!isAdmin){if(sessionId)sessions.delete(sessionId);return json(200,{authenticated:false})}return json(200,{authenticated:true,channel:session.channel})}
      if(url.pathname==="/api/music/metadata"&&method==="GET"){const vid=String(url.searchParams.get("videoId")||"");if(!/^[A-Za-z0-9_-]{11}$/.test(vid))return json(400,{error:"Некорректный ID видео."});try{const response=await fetch("https://www.youtube.com/oembed?url="+encodeURIComponent("https://www.youtube.com/watch?v="+vid)+"&format=json",{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(5000)});if(!response.ok)return json(404,{error:"Не удалось получить данные ролика."});const meta=await response.json();return json(200,{videoId:vid,title:clean(meta.title,200),author:clean(meta.author_name,120),thumbnail:meta.thumbnail_url||("https://i.ytimg.com/vi/"+vid+"/mqdefault.jpg")},{ "Cache-Control":"public, max-age=3600"})}catch(e){return json(502,{error:"Не удалось получить данные ролика."})}}
      if(url.pathname==="/api/music/queue"&&method==="GET"){const ch=channelName(url.searchParams.get("channel"));if(!ch)return json(400,{error:"Укажи корректный логин канала."});const db=await load();if(normalizeMusicQueue(db,ch,false))await save(db);const sort=(a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")),publicFields=({id,channel,nickname,videoId,url,title,status,createdAt})=>({id,channel,nickname,videoId,url,title,status,createdAt}),items=db.items.filter(x=>x.channel===ch&&["pending","playing"].includes(x.status)).sort(sort),history=db.items.filter(x=>x.channel===ch&& !["pending","playing"].includes(x.status)).sort((a,b)=>sort(b,a));return json(200,{items:items.map(publicFields),history:history.map(publicFields)})}
      if(url.pathname==="/api/music/request"&&method==="POST"){const now=Date.now(),ip=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").split(",")[0].trim(),rates=globalThis.__musicRate||(globalThis.__musicRate=new Map()),recent=(rates.get(ip)||[]).filter(t=>now-t<3600000);if(recent.length>=8)return json(429,{error:"Слишком много заявок. Попробуй позже."});const b=await bodyJson(),ch=channelName(b.channel),nick=clean(b.nickname,32)||"Аноним";if(!ch)return json(400,{error:"Укажи корректный Twitch-канал."});if(!/^[\p{L}\p{N}_ .-]{2,32}$/u.test(nick))return json(400,{error:"Ник должен содержать от 2 до 32 символов."});let vid="";try{const u=new URL(clean(b.url,500)),host=u.hostname.toLowerCase().replace(/^www\./,"").replace(/^m\./,"");if(["youtube.com","music.youtube.com"].includes(host)&&u.pathname==="/watch")vid=u.searchParams.get("v")||"";else if(host==="youtu.be")vid=u.pathname.split("/").filter(Boolean)[0]||"";else if(["youtube.com","music.youtube.com"].includes(host)&&/^\/(?:shorts|embed)\/[^/]+/.test(u.pathname))vid=u.pathname.split("/")[2]||""}catch(_){}if(!/^[A-Za-z0-9_-]{11}$/.test(vid))return json(400,{error:"Вставь корректную ссылку на видео YouTube."});const db=await load();normalizeMusicQueue(db,ch,false);const active=db.items.filter(x=>x.channel===ch&&["pending","playing"].includes(x.status));if(active.length>=50)return json(429,{error:"Очередь канала заполнена (максимум 50 треков)."});if(active.some(x=>x.videoId===vid))return json(409,{error:"Этот трек уже есть в очереди."});db.items.push({id:require("node:crypto").randomUUID(),channel:ch,nickname:nick,videoId:vid,url:"https://www.youtube.com/watch?v="+vid,title:clean(b.title,100),status:"pending",createdAt:new Date().toISOString()});await save(db);recent.push(now);rates.set(ip,recent);return json(201,{ok:true,message:"Трек добавлен в очередь."})}
      if(url.pathname==="/api/music/admin/login"&&method==="POST"){const b=await bodyJson(),ch=channelName(b.channel),password=String(b.password||"");if(!ch)return json(400,{error:"Укажи Twitch-канал для входа."});let credentials={};try{credentials=JSON.parse(process.env.MUSIC_ADMIN_CREDENTIALS||"{}")}catch(_){}if(!credentials||typeof credentials!=="object"||Array.isArray(credentials))credentials={};const pair=Object.entries(credentials).find(([login])=>String(login).trim().replace(/^@/,"").toLowerCase()===ch),expected=pair&&typeof pair[1]==="string"?pair[1]:"";if(!expected)return json(503,{error:"Для этого канала не настроен отдельный пароль в MUSIC_ADMIN_CREDENTIALS."});if(password!==expected)return json(401,{error:"Неверный пароль для этого канала."});const id=require("node:crypto").randomBytes(32).toString("hex");sessions.set(id,{channel:ch,expiresAt:Date.now()+43200000});return json(200,{ok:true,channel:ch},{"Set-Cookie":"music_admin_session="+id+"; HttpOnly; Secure; SameSite=Strict; Path=/api/music; Max-Age=43200"})}
      if(url.pathname==="/api/music/admin/logout"&&method==="POST"){if(sessionId)sessions.delete(sessionId);return json(200,{ok:true},{"Set-Cookie":"music_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/api/music; Max-Age=0"})}
      if(url.pathname.startsWith("/api/music/admin/")&&method==="POST"){if(!isAdmin)return json(401,{error:"Войди как стример, чтобы управлять очередью."});const b=await bodyJson(),ch=channelName(b.channel),id=clean(b.id,80),action=url.pathname.split("/").pop();if(!ch)return json(400,{error:"Укажи корректный Twitch-канал."});if(session.channel!==ch)return json(403,{error:"Этот вход разрешён только для канала "+session.channel+"."});const db=await load();normalizeMusicQueue(db,ch,false);const active=db.items.filter(x=>x.channel===ch&&["pending","playing"].includes(x.status)).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||""))),item=db.items.find(x=>x.id===id&&x.channel===ch);if(action==="next"){const cur=active.find(x=>x.status==="playing");if(cur)cur.status="done";normalizeMusicQueue(db,ch,true);await save(db);return json(200,{ok:true})}if(!item)return json(404,{error:"Заявка не найдена."});if(action==="play"){for(const other of active)if(other.status==="playing")other.status="pending";item.status="playing"}else if(action==="skip"||action==="remove"){item.status=action==="skip"?"skipped":"removed";normalizeMusicQueue(db,ch,true)}else return json(400,{error:"Неизвестное действие."});normalizeMusicQueue(db,ch,false);await save(db);return json(200,{ok:true})}
      if(url.pathname==="/api/music/overlay/ended"&&method==="POST"){const b=await bodyJson(),ch=channelName(b.channel),id=clean(b.id,80),resultStatus=b.status==="skipped"?"skipped":"done";if(!ch||!id)return json(400,{error:"Некорректный запрос."});const db=await load();normalizeMusicQueue(db,ch,false);const item=db.items.find(x=>x.id===id&&x.channel===ch&&x.status==="playing");if(item){item.status=resultStatus;normalizeMusicQueue(db,ch,true);await save(db)}return json(200,{ok:true})}
      return json(404,{error:"Неизвестный маршрут."})
    }catch(e){console.error("Music queue API error:",e.message);return json(e.statusCode||500,{error:e.statusCode?e.message:"Не удалось обработать музыкальную очередь."})}
  }

  // Community suggestion box: submissions remain private until moderator approval.
  if (url.pathname.startsWith("/api/community/")) {
    const sendJson = (status, payload, extraHeaders = {}) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
      res.end(JSON.stringify(payload));
    };
    const dataDir = process.env.WALL_DATA_DIR || path.join(__dirname, "data");
    const dataFile = path.join(dataDir, "community-submissions.json");
    const r2AccountId = process.env.R2_ACCOUNT_ID;
    const r2Bucket = process.env.R2_BUCKET_NAME;
    const r2Enabled = Boolean(r2AccountId && r2Bucket && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
    const r2Client = r2Enabled ? new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT || `https://${r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    }) : null;
    const r2ObjectKey = process.env.R2_OBJECT_KEY || "community-submissions.json";

    const maxImageChars = 2 * 1024 * 1024 * 1.38;
    const sessions = globalThis.__communitySessions || (globalThis.__communitySessions = new Map());
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    const rateStore = globalThis.__communityRateStore || (globalThis.__communityRateStore = new Map());
    async function readBody(limit = 3 * 1024 * 1024) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error("Размер отправки слишком большой."), { statusCode: 413 });
        chunks.push(chunk);
      }
      try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
      catch { throw Object.assign(new Error("Некорректный JSON."), { statusCode: 400 }); }
    }
    async function bodyToString(body) {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    }
    async function readLocalDb() {
      await fs.promises.mkdir(dataDir, { recursive: true });
      try {
        const parsed = JSON.parse(await fs.promises.readFile(dataFile, "utf8"));
        return { submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [] };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { submissions: [] };
      }
    }
    async function loadDb() {
      if (r2Enabled) {
        try {
          const result = await r2Client.send(new GetObjectCommand({ Bucket: r2Bucket, Key: r2ObjectKey }));
          const parsed = JSON.parse(await bodyToString(result.Body));
          return { submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [] };
        } catch (error) {
          const missing = error.name === "NoSuchKey" || error.Code === "NoSuchKey" || error.$metadata?.httpStatusCode === 404;
          if (!missing) {
            console.error("Community R2 data could not be read:", error.message);
            throw new Error("Не удалось прочитать данные заявок из R2. Изменения остановлены, чтобы не потерять данные.");
          }
          // First R2 run: migrate the existing local JSON once, if present.
          const localDb = await readLocalDb();
          if (localDb.submissions.length) {
            await r2Client.send(new PutObjectCommand({
              Bucket: r2Bucket, Key: r2ObjectKey,
              Body: JSON.stringify(localDb, null, 2), ContentType: "application/json"
            }));
          }
          return localDb;
        }
      }
      return readLocalDb();
    }
    async function saveDb(db) {
      const serialized = JSON.stringify(db, null, 2);
      if (r2Enabled) {
        await r2Client.send(new PutObjectCommand({
          Bucket: r2Bucket, Key: r2ObjectKey,
          Body: serialized, ContentType: "application/json"
        }));
        return;
      }
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmp = dataFile + ".tmp";
      await fs.promises.writeFile(tmp, serialized, { mode: 0o600 });
      await fs.promises.rename(tmp, dataFile);
    }
    function cleanText(value, max) { return String(value || "").replace(/\u0000/g, "").trim().slice(0, max); }
    function getSession() {
      const cookie = String(req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith("community_session="));
      const sessionId = cookie ? cookie.slice("community_session=".length) : "";
      const session = sessions.get(sessionId);
      if (!session || session.expiresAt < Date.now()) { if (sessionId) sessions.delete(sessionId); return null; }
      return { ...session, sessionId };
    }
    function moderatorsConfig() {
      let configured = {};
      try { configured = JSON.parse(process.env.WALL_MODERATORS || "{}"); } catch (_) {}
      return configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {};
    }
    function verifyCredentials(username, password) {
      const normalized = cleanText(username, 40);
      if (normalized.toLowerCase() === "admin" && process.env.WALL_ADMIN_PASSWORD && password === process.env.WALL_ADMIN_PASSWORD) return { username: "admin", role: "admin" };
      const found = Object.entries(moderatorsConfig()).find(([name, secret]) => name.toLowerCase() === normalized.toLowerCase() && typeof secret === "string" && secret && password === secret);
      return found ? { username: found[0], role: "moderator" } : null;
    }
    const method = req.method || "GET";
    try {
      if (url.pathname === "/api/community/submissions" && method === "POST") {
        const now = Date.now(), bucket = rateStore.get(ip) || [], recent = bucket.filter(time => now - time < 60 * 60_000);
        if (recent.length >= 5) return sendJson(429, { error: "Слишком много отправок. Попробуйте позже." });
        const body = await readBody();
        const nickname = cleanText(body.nickname, 32);
        const kind = ["streamer", "wall", "site", "moderator"].includes(body.kind) ? body.kind : "";
        const text = cleanText(body.text, 1200);
        if (!/^[\p{L}\p{N}_ .-]{2,32}$/u.test(nickname)) return sendJson(400, { error: "Укажите никнейм длиной от 2 до 32 символов." });
        if (!kind) return sendJson(400, { error: "Выберите тип предложения." });
        let twitchLogin = "";
        if (kind === "streamer") {
          const raw = cleanText(body.twitch, 300);
          try {
            if (/^[a-zA-Z0-9_]{1,25}$/.test(raw)) {
              twitchLogin = raw.toLowerCase();
            } else {
              const candidate = new URL(raw.includes("://") ? raw : "https://" + raw);
              const login = candidate.pathname.split("/").filter(Boolean)[0] || "";
              if (!/^(?:www\.)?twitch\.tv$/i.test(candidate.hostname) || !/^[a-zA-Z0-9_]{1,25}$/.test(login)) throw new Error("invalid");
              twitchLogin = login.toLowerCase();
            }
          } catch (_) { return sendJson(400, { error: "Введите корректную ссылку на Twitch или ник канала." }); }
        }
        let moderatorName = "";
        let moderatorOf = [];
        if (kind === "moderator") {
          moderatorName = cleanText(body.moderatorName || nickname, 32);
          const rawModerates = cleanText(body.moderatorOf, 300);
          moderatorOf = [...new Set(rawModerates.split(/[\s,;]+/).map(value => value.replace(/^@/, "").toLowerCase()).filter(Boolean))];
          if (!/^[\p{L}\p{N}_ .-]{2,32}$/u.test(moderatorName)) return sendJson(400, { error: "Укажите корректный ник модератора." });
          if (!rawModerates || !moderatorOf.length || moderatorOf.some(login => !/^[a-zA-Z0-9_]{1,25}$/.test(login))) return sendJson(400, { error: "Обязательно укажите корректные Twitch-ники стримеров, где человек будет модератором." });
        }
        let imageData = "";
        if (body.image) {
          if (typeof body.image !== "string" || body.image.length > maxImageChars) return sendJson(413, { error: "Изображение слишком большое (максимум 2 МБ)." });
          const match = body.image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
          if (!match) return sendJson(400, { error: "Поддерживаются изображения JPG, PNG, WEBP или GIF." });
          const bytes = Buffer.from(match[2], "base64");
          if (!bytes.length || bytes.length > 2 * 1024 * 1024) return sendJson(413, { error: "Изображение должно быть не больше 2 МБ." });
          const signatures = {
            "image/jpeg": bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
            "image/png": bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
            "image/webp": bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
            "image/gif": bytes.toString("ascii", 0, 3) === "GIF"
          };
          if (!signatures[match[1]]) return sendJson(400, { error: "Формат файла не совпадает с содержимым изображения." });
          imageData = body.image;
        }
        if (kind === "wall" && !text && !imageData) return sendJson(400, { error: "Добавьте текст и/или изображение для стены." });
        if (kind === "site" && !text) return sendJson(400, { error: "Опишите предложение по улучшению сайта." });
        if (kind === "moderator" && (!moderatorName || !moderatorOf.length)) return sendJson(400, { error: "Укажите имя модератора и каналы, где он будет модератором." });
        if (kind === "streamer" && !twitchLogin) return sendJson(400, { error: "Нужен Twitch-канал." });
        const db = await loadDb();
        if (kind === "streamer" && db.submissions.some(item => item.kind === "streamer" && item.twitchLogin === twitchLogin && item.status !== "rejected")) return sendJson(409, { error: "Этот канал уже предложен или опубликован." });
        db.submissions.push({
          id: require("node:crypto").randomUUID(), kind, nickname, text, twitchLogin, imageData, moderatorName, moderatorOf,
          status: "pending", createdAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null
        });
        await saveDb(db);
        recent.push(now); rateStore.set(ip, recent);
        return sendJson(201, { ok: true, message: "Отправлено на модерацию. Спасибо!" });
      }
      if (url.pathname === "/api/community/posts" && method === "GET") {
        const db = await loadDb();
        return sendJson(200, { submissions: db.submissions.filter(item => item.status === "approved").map(item => ({
          id: item.id, kind: item.kind, nickname: item.nickname, text: item.text, twitchLogin: item.twitchLogin, imageData: item.imageData, moderatorName: item.moderatorName, moderatorOf: item.moderatorOf, createdAt: item.createdAt
        })) });
      }
      if (url.pathname === "/api/community/login" && method === "POST") {
        if (!process.env.WALL_ADMIN_PASSWORD && !Object.keys(moderatorsConfig()).length) return sendJson(503, { error: "Модерация ещё не настроена владельцем сайта." });
        const body = await readBody(20 * 1024);
        const identity = verifyCredentials(body.username, String(body.password || ""));
        if (!identity) return sendJson(401, { error: "Неверный логин или пароль." });
        const sessionId = require("node:crypto").randomBytes(32).toString("hex");
        sessions.set(sessionId, { ...identity, expiresAt: Date.now() + 12 * 60 * 60_000 });
        return sendJson(200, { ok: true, username: identity.username, role: identity.role }, {
          "Set-Cookie": "community_session=" + sessionId + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200"
        });
      }
      if (url.pathname === "/api/community/logout" && method === "POST") {
        const session = getSession(); if (session) sessions.delete(session.sessionId);
        return sendJson(200, { ok: true }, { "Set-Cookie": "community_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
      }
      if (url.pathname === "/api/community/moderation" && method === "GET") {
        const session = getSession(); if (!session) return sendJson(401, { error: "Нужен вход модератора." });
        const db = await loadDb();
        return sendJson(200, { submissions: db.submissions.filter(item => item.status === "pending").map(item => ({
          id: item.id, kind: item.kind, nickname: item.nickname, text: item.text, twitchLogin: item.twitchLogin, imageData: item.imageData, moderatorName: item.moderatorName, moderatorOf: item.moderatorOf, createdAt: item.createdAt
        })), moderator: session.username, role: session.role });
      }
      const actionMatch = url.pathname.match(/^\/api\/community\/moderation\/([a-f0-9-]+)$/i);
      if (actionMatch && method === "POST") {
        const session = getSession(); if (!session) return sendJson(401, { error: "Нужен вход модератора." });
        const body = await readBody(20 * 1024), action = String(body.action || "");
        if (!["approve", "reject", "delete"].includes(action)) return sendJson(400, { error: "Неизвестное действие." });
        const db = await loadDb(), item = db.submissions.find(entry => entry.id === actionMatch[1]);
        if (!item) return sendJson(404, { error: "Заявка не найдена." });
        if (item.status === "approved" && ["wall", "streamer"].includes(item.kind) && action !== "approve") {
          const typeLabel = item.kind === "streamer" ? "Одобренных стримеров" : "Одобренных публикаций на стене";
          return sendJson(409, { error: typeLabel + " нельзя отклонить или удалить. Они остаются опубликованными после перезагрузки страницы." });
        }
        if (action === "delete") db.submissions = db.submissions.filter(entry => entry.id !== item.id);
        else { item.status = action === "approve" ? "approved" : "rejected"; item.reviewedAt = new Date().toISOString(); item.reviewedBy = session.username; }
        await saveDb(db); return sendJson(200, { ok: true });
      }
      return sendJson(404, { error: "Неизвестный маршрут." });
    } catch (error) {
      console.error("Community suggestion API error:", error.message);
      return sendJson(error.statusCode || 500, { error: error.statusCode ? error.message : "Не удалось обработать запрос. Попробуйте позже." });
    }
  }

  const requested = url.pathname === "/music-dock" || url.pathname === "/music-dock/" ? "music-dock.html" : url.pathname === "/" ? "index.html" : (url.pathname === "/widgets" || url.pathname === "/widgets/") ? "widgets.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    const headers = { "Content-Type": types[ext] || "application/octet-stream" };
    // HTML must not be served from a stale browser/proxy cache after deployments (e.g. old music-login instructions).
    if (ext === ".html") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate, proxy-revalidate";
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`1°6 Community running at http://localhost:${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn("Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET. Live statuses will not work until configured.");
  }
});
