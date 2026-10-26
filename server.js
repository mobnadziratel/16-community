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
  "ne_twig"
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
        const kind = body.kind === "streamer" ? "streamer" : body.kind === "wall" ? "wall" : "";
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
        if (kind === "streamer" && !twitchLogin) return sendJson(400, { error: "Нужен Twitch-канал." });
        const db = await loadDb();
        if (kind === "streamer" && db.submissions.some(item => item.kind === "streamer" && item.twitchLogin === twitchLogin && item.status !== "rejected")) return sendJson(409, { error: "Этот канал уже предложен или опубликован." });
        db.submissions.push({
          id: require("node:crypto").randomUUID(), kind, nickname, text, twitchLogin, imageData,
          status: "pending", createdAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null
        });
        await saveDb(db);
        recent.push(now); rateStore.set(ip, recent);
        return sendJson(201, { ok: true, message: "Отправлено на модерацию. Спасибо!" });
      }
      if (url.pathname === "/api/community/posts" && method === "GET") {
        const db = await loadDb();
        return sendJson(200, { submissions: db.submissions.filter(item => item.status === "approved").map(item => ({
          id: item.id, kind: item.kind, nickname: item.nickname, text: item.text, twitchLogin: item.twitchLogin, imageData: item.imageData, createdAt: item.createdAt
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
          id: item.id, kind: item.kind, nickname: item.nickname, text: item.text, twitchLogin: item.twitchLogin, imageData: item.imageData, createdAt: item.createdAt
        })), moderator: session.username, role: session.role });
      }
      const actionMatch = url.pathname.match(/^\/api\/community\/moderation\/([a-f0-9-]+)$/i);
      if (actionMatch && method === "POST") {
        const session = getSession(); if (!session) return sendJson(401, { error: "Нужен вход модератора." });
        const body = await readBody(20 * 1024), action = String(body.action || "");
        if (!["approve", "reject", "delete"].includes(action)) return sendJson(400, { error: "Неизвестное действие." });
        const db = await loadDb(), item = db.submissions.find(entry => entry.id === actionMatch[1]);
        if (!item) return sendJson(404, { error: "Заявка не найдена." });
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

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
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
