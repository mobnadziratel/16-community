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
  "dima26rx1",
  "ishak_kodolov",
  "mandarin555q",
  "z3kat",
  "ssh1nxx"
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


const WALL_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const WALL_DB_FILE = path.join(WALL_DATA_DIR, "wall-posts.json");
const WALL_MODERATOR_TOKENS = String(process.env.WALL_MODERATOR_TOKENS || "").split(",").map(v => v.trim()).filter(v => v.length >= 24);
const wallRateLimits = new Map();
function wallJson(res, status, data) { res.writeHead(status, { "Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff" }); res.end(JSON.stringify(data)); }
async function readWallDb() {
  try { const db=JSON.parse(await fs.promises.readFile(WALL_DB_FILE,"utf8")); return Array.isArray(db.posts)?db:{posts:[]}; }
  catch(e) { if(e.code==="ENOENT") return {posts:[]}; throw e; }
}
async function writeWallDb(db) {
  await fs.promises.mkdir(WALL_DATA_DIR,{recursive:true,mode:0o700});
  const tmp=WALL_DB_FILE+".tmp"; await fs.promises.writeFile(tmp,JSON.stringify(db),{mode:0o600}); await fs.promises.rename(tmp,WALL_DB_FILE);
}
function wallImageType(b) {
  if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
  if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return "image/jpeg";
  if(b.length>=12&&b.toString("ascii",0,4)==="RIFF"&&b.toString("ascii",8,12)==="WEBP")return "image/webp";
  if(b.length>=6&&["GIF87a","GIF89a"].includes(b.toString("ascii",0,6)))return "image/gif"; return null;
}
async function wallReadBody(req,max=3*1024*1024) {
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Object.assign(new Error("Слишком большой запрос"),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw Object.assign(new Error("Некорректный JSON"),{status:400});}
}
function wallIsModerator(req) {
  const h=String(req.headers.authorization||"");const supplied=h.startsWith("Bearer ")?h.slice(7):"";if(!supplied||!WALL_MODERATOR_TOKENS.length)return false;
  const crypto=require("node:crypto");return WALL_MODERATOR_TOKENS.some(token=>{const a=Buffer.from(token),b=Buffer.from(supplied);return a.length===b.length&&crypto.timingSafeEqual(a,b);});
}
function wallRateLimit(req,res,key,limit,windowMs) {
  const now=Date.now(),id=key+":"+String(req.socket.remoteAddress||"unknown").slice(0,80);const e=wallRateLimits.get(id);
  if(!e||now-e.start>windowMs)wallRateLimits.set(id,{start:now,count:1});else if(++e.count>limit){wallJson(res,429,{error:"Слишком много запросов. Попробуйте позже."});return false;}
  if(wallRateLimits.size>5000)for(const[k,v]of wallRateLimits)if(now-v.start>windowMs)wallRateLimits.delete(k);return true;
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


  if (url.pathname.startsWith("/api/wall/")) {
    try {
      if(req.method==="GET"&&url.pathname==="/api/wall/posts"){
        const db=await readWallDb();wallJson(res,200,{posts:db.posts.filter(p=>p.status==="approved").sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({id,text,image,imageType,createdAt})=>({id,text,image:image?"data:"+imageType+";base64,"+image:null,createdAt}))});return;
      }
      if(req.method==="POST"&&url.pathname==="/api/wall/submissions"){
        if(!wallRateLimit(req,res,"submit",5,3600000))return;
        if(!String(req.headers["content-type"]||"").toLowerCase().startsWith("application/json")){wallJson(res,415,{error:"Ожидался JSON"});return;}
        const body=await wallReadBody(req);const text=String(body.text||"").trim();
        if(text.length>1200){wallJson(res,400,{error:"Текст должен быть не длиннее 1200 символов"});return;}
        if(!text&&!body.image){wallJson(res,400,{error:"Добавьте текст или фотографию"});return;}
        let image=null,imageType=null;
        if(body.image){const m=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image));if(!m){wallJson(res,400,{error:"Поддерживаются PNG, JPG, WEBP и GIF"});return;}
          const b=Buffer.from(m[2],"base64");if(!b.length||b.length>2*1024*1024||wallImageType(b)!==m[1]){wallJson(res,400,{error:"Фото не прошло проверку или превышает 2 МБ"});return;}image=b.toString("base64");imageType=m[1];}
        const db=await readWallDb();db.posts.push({id:require("node:crypto").randomUUID(),text,image,imageType,status:"pending",createdAt:new Date().toISOString()});await writeWallDb(db);
        wallJson(res,201,{ok:true,message:"Отправлено на модерацию. Спасибо!"});return;
      }
      if(req.method==="GET"&&url.pathname==="/api/wall/moderation"){
        if(!wallIsModerator(req)){wallJson(res,WALL_MODERATOR_TOKENS.length?401:503,{error:WALL_MODERATOR_TOKENS.length?"Неверный токен модератора":"Модерация ещё не настроена на сервере"});return;}
        const db=await readWallDb();wallJson(res,200,{posts:db.posts.filter(p=>p.status==="pending").sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(p=>({...p,image:p.image?"data:"+p.imageType+";base64,"+p.image:null}))});return;
      }
      const m=/^\/api\/wall\/moderation\/([0-9a-f-]+)$/.exec(url.pathname);
      if(req.method==="POST"&&m){
        if(!wallIsModerator(req)){wallJson(res,WALL_MODERATOR_TOKENS.length?401:503,{error:WALL_MODERATOR_TOKENS.length?"Неверный токен модератора":"Модерация ещё не настроена на сервере"});return;}
        if(!wallRateLimit(req,res,"moderate",120,3600000))return;
        const body=await wallReadBody(req,4096);if(!["approved","rejected"].includes(body.status)){wallJson(res,400,{error:"Недопустимое действие"});return;}
        const db=await readWallDb(),post=db.posts.find(p=>p.id===m[1]);if(!post){wallJson(res,404,{error:"Публикация не найдена"});return;}
        post.status=body.status;post.moderatedAt=new Date().toISOString();await writeWallDb(db);wallJson(res,200,{ok:true});return;
      }
      wallJson(res,404,{error:"Маршрут не найден"});return;
    } catch(e){wallJson(res,e.status||500,{error:e.status?e.message:"Ошибка обработки публикации"});if(!e.status)console.error("Wall API error:",e.message);return;}
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
