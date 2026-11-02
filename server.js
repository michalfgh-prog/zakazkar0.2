const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 8766;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'online-data.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const APP_VERSION = '2.0.0';
const READER = 'https://r.jina.ai/';
const MAX_BODY = 64 * 1024;
const MIN_READER_INTERVAL_MS = 3100;
let onlineData = { users:[], sessions:[], messages:[], posts:[] };
try { onlineData = { ...onlineData, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
onlineData.posts ||= [];
const onlinePresence = new Map();
let dbPool = null;
async function initializeDatabase() {
  if (!DATABASE_URL) return;
  const { Pool } = require('pg');
  dbPool = new Pool({ connectionString:DATABASE_URL, max:5, idleTimeoutMillis:30000, connectionTimeoutMillis:10000 });
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user', password_hash TEXT NOT NULL,
      salt TEXT NOT NULL, created BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx ON app_sessions(user_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      body TEXT NOT NULL, created BIGINT NOT NULL, read_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS chat_messages_sender_created_idx ON chat_messages(sender_id, created);
    CREATE INDEX IF NOT EXISTS chat_messages_recipient_created_idx ON chat_messages(recipient_id, created);
    CREATE TABLE IF NOT EXISTS community_posts (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      payload JSONB NOT NULL, created BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS community_posts_created_idx ON community_posts(created DESC);
  `);
  for (const u of onlineData.users) {
    await dbPool.query(`INSERT INTO app_users(id,name,email,role,password_hash,salt,created)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(email) DO NOTHING`,
      [u.id,u.name,u.email,u.role||'user',u.passwordHash,u.salt,u.created||Date.now()]);
  }
  for (const s of onlineData.sessions) {
    await dbPool.query(`INSERT INTO app_sessions(token_hash,user_id,expires)
      VALUES($1,$2,$3) ON CONFLICT(token_hash) DO NOTHING`,[s.tokenHash,s.userId,s.expires]);
  }
  for (const m of onlineData.messages) {
    await dbPool.query(`INSERT INTO chat_messages(id,sender_id,recipient_id,body,created,read_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[m.id,m.from,m.to,m.text,m.ts,m.readAt||null]);
  }
  const databaseAuthors=new Map((await dbPool.query('SELECT id,name FROM app_users')).rows.map(author=>[author.id,author.name]));
  for (const post of onlineData.posts) {
    const author=onlineData.users.find(u=>u.id===post.authorId);
    const authorName=post.authorName||author?.name||databaseAuthors.get(post.authorId);
    if(!authorName) continue;
    const payload={...post,authorName};
    await dbPool.query(`INSERT INTO community_posts(id,author_id,payload,created)
      VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(id) DO NOTHING`,
      [payload.id,payload.authorId,JSON.stringify(payload),payload.created||Date.now()]);
  }
  const [users,sessions] = await Promise.all([
    dbPool.query('SELECT id,name,email,role,password_hash AS "passwordHash",salt,created FROM app_users'),
    dbPool.query('SELECT token_hash AS "tokenHash", user_id AS "userId",expires FROM app_sessions WHERE expires > $1',[Date.now()])
  ]);
  onlineData.users=users.rows.map(u=>({...u,created:Number(u.created)}));
  onlineData.sessions=sessions.rows.map(s=>({...s,expires:Number(s.expires)}));
  console.log(JSON.stringify({database:'postgresql',users:users.rowCount}));
}
function saveOnlineData() {
  fs.mkdirSync(DATA_DIR, { recursive:true });
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(onlineData), { mode:0o600 });
  fs.renameSync(temp, DATA_FILE);
}
async function readFeedPosts() {
  if (!dbPool) return onlineData.posts;
  const {rows}=await dbPool.query('SELECT payload FROM community_posts ORDER BY created DESC LIMIT 500');
  return rows.map(row=>row.payload);
}
async function readFeedPost(id) {
  if (!dbPool) return onlineData.posts.find(post=>post.id===id)||null;
  const {rows}=await dbPool.query('SELECT payload FROM community_posts WHERE id=$1',[id]);
  return rows[0]?.payload||null;
}
async function writeFeedPost(post) {
  if (dbPool) {
    await dbPool.query(`INSERT INTO community_posts(id,author_id,payload,created)
      VALUES($1,$2,$3::jsonb,$4)
      ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,created=EXCLUDED.created`,
      [post.id,post.authorId,JSON.stringify(post),post.created]);
  }
  const index=onlineData.posts.findIndex(item=>item.id===post.id);
  if(index<0) onlineData.posts.push(post); else onlineData.posts[index]=post;
  if(!dbPool) saveOnlineData();
}
async function updateFeedPost(id, updater) {
  if (!dbPool) {
    const post=onlineData.posts.find(item=>item.id===id);
    if(!post) return null;
    const result=updater(post);
    saveOnlineData();
    return {post,result};
  }
  const client=await dbPool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT payload FROM community_posts WHERE id=$1 FOR UPDATE',[id]);
    if(!rows.length){await client.query('ROLLBACK');return null;}
    const post=rows[0].payload;
    const result=updater(post);
    await client.query('UPDATE community_posts SET payload=$2::jsonb WHERE id=$1',[id,JSON.stringify(post)]);
    await client.query('COMMIT');
    const index=onlineData.posts.findIndex(item=>item.id===id);
    if(index<0) onlineData.posts.push(post); else onlineData.posts[index]=post;
    return {post,result};
  } catch(error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
if(onlineData.users.length&&!onlineData.users.some(u=>u.role==='admin')){onlineData.users[0].role='admin';try{saveOnlineData();}catch{}}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function publicUser(user) { return { id:user.id, name:user.name, email:user.email, role:user.role||'user' }; }
function getCookie(req, key) {
  const cookies = String(req.headers.cookie||'').split(';');
  for (const cookie of cookies) { const i=cookie.indexOf('='); if(i>0 && cookie.slice(0,i).trim()===key) return decodeURIComponent(cookie.slice(i+1).trim()); }
  return '';
}
async function currentUser(req) {
  const token=getCookie(req,'zakazkar_session'); if(!token) return null;
  if(dbPool) {
    const {rows}=await dbPool.query(`SELECT u.id,u.name,u.email,u.role FROM app_sessions s
      JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires>$2`,[sha256(token),Date.now()]);
    const user=rows[0]||null;
    if(user) onlinePresence.set(user.id,Date.now());
    return user;
  }
  const session=onlineData.sessions.find(s=>s.tokenHash===sha256(token)&&s.expires>Date.now());
  const user=session ? onlineData.users.find(u=>u.id===session.userId) || null : null;
  if(user) onlinePresence.set(user.id,Date.now());
  return user;
}
function readJson(req, max=16*1024) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',chunk=>{ raw+=chunk; if(Buffer.byteLength(raw)>max){reject(Object.assign(new Error('Požadavek je příliš velký.'),{status:413}));req.destroy();} });
    req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(Object.assign(new Error('Neplatná data.'),{status:400}));}});
    req.on('error',reject);
  });
}
function setSessionCookie(req,res,token) {
  const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
  res.setHeader('Set-Cookie', `zakazkar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure?'; Secure':''}`);
}
async function requireUser(req,res) { const user=await currentUser(req); if(!user) json(res,401,{error:'Pro chat se přihlaste ke svému účtu.'}); return user; }
function newId() { return crypto.randomUUID(); }
const authAttempts = new Map();
function authRateLimited(req) {
  const ip=req.socket.remoteAddress||'unknown', now=Date.now(), old=authAttempts.get(ip)||[];
  const recent=old.filter(t=>now-t<10*60*1000); recent.push(now); authAttempts.set(ip,recent);
  return recent.length>30;
}
// Only public, non-governmental sources used for real service and trade leads.
const SOURCES = [
  { id:'epoptavka', name:'ePoptávka.cz', url:'https://poptavky.epoptavka.cz/moravskoslezsky-kraj', regionScoped:true, kind:'Poptávka' },
  { id:'poptavej', name:'Poptávej.cz — řemesla MSK', url:'https://www.poptavej.cz/poptavky/remesla/kraj-moravskoslezsky', regionScoped:true, kind:'Poptávka' },
  { id:'poptavky', name:'Poptávky.cz', url:'https://www.poptavky.cz/poptavky/moravskoslezsky-kraj', regionScoped:true, kind:'Poptávka' },
  { id:'poptavkaeu', name:'Poptávka-EU.cz', url:'https://www.poptavka-eu.cz/kraje/CZ080/?filter=0', regionScoped:true, kind:'Poptávka' },
  { id:'zakazky', name:'Zakázky.služby.cz', url:'https://zakazky.sluzby.cz/remesla-profese/moravskoslezsky-kraj', regionScoped:true, kind:'Poptávka' },
  { id:'firmyzarohem', name:'Firmyzarohem.cz — řemesla MSK', url:'https://www.firmyzarohem.cz/zakazky/remesla/kraj/moravskoslezsky', regionScoped:true, kind:'Poptávka' },
  { id:'firmyzarohem-stav', name:'Firmyzarohem.cz — stavebnictví MSK', url:'https://www.firmyzarohem.cz/zakazky/stavebnictvi/kraj/moravskoslezsky', regionScoped:true, kind:'Poptávka' },
  { id:'firmyzarohem-sluzby', name:'Firmyzarohem.cz — služby MSK', url:'https://www.firmyzarohem.cz/zakazky/sluzby/kraj/moravskoslezsky', regionScoped:true, kind:'Poptávka' },
  { id:'aaapoptavka', name:'AAA Poptávka.cz', url:'https://www.aaapoptavka.cz/poptavky/prace', regionScoped:false, kind:'Poptávka' },
  { id:'aaasubdodavky', name:'AAA Poptávka — subdodávky', url:'https://www.aaapoptavka.cz/poptavky/subdodavky', regionScoped:false, kind:'Poptávka' },
  { id:'pop24', name:'Pop24.cz', url:'https://pop24.cz/', regionScoped:false, kind:'Poptávka' },
  { id:'hledamruce', name:'Hledám ruce', url:'https://www.hledamruce.cz/', regionScoped:false, kind:'Poptávka' },
  { id:'ceskestavby', name:'ČESKÉSTAVBY.cz — poptávky', url:'https://www.ceskestavby.cz/poptavka/', regionScoped:false, kind:'Poptávka' },
  { id:'dohodni', name:'Dohodni.cz', url:'https://dohodni.com/', regionScoped:false, kind:'Poptávka' },
  { id:'ubo', name:'UBO.cz', url:'https://www.ubo.cz/', regionScoped:false, kind:'Poptávka' },
  { id:'dalbovac', name:'Dalbovač.cz', url:'https://www.dalbovac.cz/', regionScoped:false, kind:'Poptávka' },
  { id:'nejstav', name:'NejStav.cz', url:'https://nejstav.cz/', regionScoped:false, kind:'Poptávka' },
  { id:'bazos', name:'Bazoš.cz (služby)', url:'https://sluzby.bazos.cz/moravskoslezsky/', regionScoped:true, kind:'Inzerát/služba', requestOnly:true },
  { id:'supersoused', name:'SuperSoused.cz', url:'https://www.supersoused.cz/', regionScoped:false, kind:'Poptávka', requestOnly:true },
  { id:'nevyhazujto', name:'Nevyhazujto.cz', url:'https://www.nevyhazujto.cz/', regionScoped:false, kind:'Inzerát/služba', requestOnly:true },
  { id:'vsezaodvoz', name:'Všezaodvoz.cz', url:'https://www.vsezaodvoz.cz/', regionScoped:false, kind:'Inzerát/služba', requestOnly:true }
];
const SOURCE_BY_ID = new Map(SOURCES.map(source => [source.id, source]));
const CITIES = ['Ostrava','Opava','Karviná','Havířov','Frýdek-Místek','Frýdek','Třinec','Nový Jičín','Bohumín','Bruntál','Krnov','Vítkov','Odry','Hlučín','Bílovec','Studénka','Jablunkov','Český Těšín','Kopřivnice','Příbor','Frenštát','Rýmařov','Ostravice','Orlová','Třebovice','Vítkovice','Bítov','Albrechtice'];
const REGION_HINTS = ['moravskoslezský','moravskoslezsko','ostravsko','opavsko','těšínsko','hlučínsko','severní morava','severomoravský','bruntálsko','karvinsko'];
const ALIASES = {
  'stěhování':['stěhovací','přestěhování','stěhovat'],
  'vyklízení':['vyklízení','vyklízecí','vyklizení','vyklidit'],
  'odvoz':['odvoz','suti','sutě','suť','odpadu','odpadů','stavebního odpadu'],
  'kontejner':['kontejner','kontejnery','kontejneru'],
  'bourání':['bourání','bourací','bourat','demolice','demoliční'],
  'likvidace':['likvidace','likvidovat','odstranění odpadu'],
  'zedník':['zedník','zednické','zednický','zednických'],
  'instalatér':['instalatér','instalatérské','instalatérský','instalace vody'],
  'topenář':['topenář','topenářské','topenářský','vytápění'],
  'obkladač':['obkladač','obkladačské','obklady a dlažby'],
  'elektrikář':['elektrikář','elektroinstalace','elektroinstalační'],
  'podlahář':['podlahář','podlahářské','pokládka podlah'],
  'malíř':['malíř','malířské','výmalba','malování'],
  'klempíř':['klempíř','klempířské'],
  'tesař':['tesař','tesařské'],
  'truhlář':['truhlář','truhlářské'],
  'omítky':['omítky','omítka','omítání'],
  'sádrokarton':['sádrokarton','sdk','sádrokartonářské'],
  'střecha':['střecha','střechy','střešní','krytina'],
  'beton':['beton','betonáž','betonování'],
  'klimatizace':['klimatizace','klimatizaci','klimatizační'],
  'plyn':['plyn','plynový','plynové'],
  'kontejner':['kontejner','kontejnery','kontejneru']
};
let nextReaderStart = 0;
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
function json(res, status, data) { return send(res, status, JSON.stringify(data)); }
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function decodeText(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();
}
function cleanMarkdown(text) {
  return decodeText(String(text || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_>#]/g, ' '));
}
function matchesWork(text, keywords) {
  const corpus = normalize(text);
  return keywords.some(keyword => {
    const key = normalize(keyword);
    if (key && corpus.includes(key)) return true;
    const aliases = ALIASES[keyword] || ALIASES[key] || [];
    return aliases.some(alias => corpus.includes(normalize(alias)));
  });
}
function isInRegion(text) {
  const value = normalize(text);
  if (CITIES.some(city => value.includes(normalize(city)))) return true;
  if (REGION_HINTS.some(hint => value.includes(normalize(hint)))) return true;
  return /\b(7[0-4]\d|78\d|79\d)\s?\d{2}\b/.test(String(text));
}
function detectLocation(text, regionScoped) {
  const value = normalize(text);
  for (const city of CITIES) if (value.includes(normalize(city))) return `MSK · ${city}`;
  if (REGION_HINTS.some(hint => value.includes(normalize(hint)))) return 'Moravskoslezský kraj';
  return regionScoped ? 'Moravskoslezský kraj' : 'Lokalitu ověřte na portálu';
}
function normalizeUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (!['http:','https:'].includes(url.protocol)) return null;
    return url.href.split('#')[0];
  } catch { return null; }
}
function rootHost(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
}
function hasCustomerRequestIntent(text) {
  const value = normalize(text);
  return /(poptav|hledam|hledame|shanim|shanime|potrebuji|potrebujeme|poptavam|poptavame|rad bych|prosim o|zakazku|zakazka|oprava|rekonstrukce|montaz|realizace|vymena|instalace|vyroba|zhotoveni|pokladka|bourani|vyklizeni|stehovani|odvoz|demontaz|zatepleni|vymalba|malovani|omitani|betonaz|likvidace|opravit|postavit)/.test(value);
}
function intentIsRealRequest(text, source) {
  const value = normalize(text);
  if (/(vytvorte si zdarma|uspesne ukonceno|vyzkouset nyni|vlastni www stranky|e shop|webove stranky|registrace|prihlaseni|volne misto|pracovni pozice|pracovni nabidka|zivotopis|mzda|nastup ihned|prijmeme|hledame zamestnance)/.test(value)) return false;
  if (/verejn.{0,16}zakaz|statn.{0,12}zakaz|zad[aá]vac[ií] r[ií]zen[ií]|verejn[yý] zadavatel|tender|vyberov[eé] r[ií]zen[ií]/i.test(value)) return false;
  if (!hasCustomerRequestIntent(value)) return false;
  if (source.requestOnly && !/(poptav|hledam|hledame|shanim|shanime|potrebuji|potrebujeme|poptavam|poptavame|zakazku|zakazka|nabidnete|odvoz sut|odvoz odpadu)/.test(value)) return false;
  return true;
}
function extractDate(text) {
  const value = decodeText(text);
  const match = value.match(/(?:Dnes|Včera|Předevčírem)\s+\d{1,2}:\d{2}|\b\d{1,2}\.\s*\d{1,2}\.\s*20\d{2}\b|\bpřed\s+\d+\s+(?:minutami?|hodinami?|dny?)\b/i);
  return match ? match[0] : '';
}
function extractCandidates(markdown, source, keywords) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const results = [], seen = new Set();
  const linkPattern = /\[([^\]]{5,240})\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;
  for (let i = 0; i < lines.length; i++) {
    linkPattern.lastIndex = 0;
    let match;
    while ((match = linkPattern.exec(lines[i])) !== null) {
      const title = decodeText(match[1].replace(/\*\*/g, '')).replace(/^[\W_]+|[\W_]+$/gu, '').trim();
      const url = normalizeUrl(match[2], source.url);
      if (!url || title.length < 18 || title.length > 220) continue;
      if (/^(image\s*\d*|obrazek|logo|registrace|přihlásit|registrovat|více|firmy|kontakt|nápověda|hledat|filtr|poptávky|kategorie|ceník|podmínky)\b/i.test(title)) continue;
      if (/(vytvorte si zdarma|uspesne ukonceno|vyzkouset nyni|vlastni www stranky|e shop|webove stranky|registrace)/i.test(normalize(title))) continue;
      const parsed = new URL(url);
      if (rootHost(parsed.hostname) !== rootHost(new URL(source.url).hostname)) continue;
      if (url === normalizeUrl(source.url, source.url)) continue;
      const before = lines[i].slice(0, match.index), after = lines[i].slice(match.index + match[0].length);
      const previousBoundary = Math.max(before.lastIndexOf(')'), before.lastIndexOf(']'));
      const nextLink = /\[[^\]]*\]\(/.exec(after);
      const localBefore = previousBoundary >= 0 ? before.slice(previousBoundary + 1) : before.slice(-220);
      const localAfter = nextLink ? after.slice(0, nextLink.index) : after.slice(0, 260);
      let localText = localBefore + ' ' + title + ' ' + localAfter;
      for (const neighbor of [i - 1, i + 1]) {
        if (neighbor >= 0 && neighbor < lines.length && lines[neighbor].length <= 240 && !/\[[^\]]+\]\(https?:\/\//.test(lines[neighbor])) localText += ' ' + lines[neighbor];
      }
      const context = cleanMarkdown(localText).slice(0, 500), corpus = title + ' ' + context;
      if (!matchesWork(corpus, keywords) || !intentIsRealRequest(corpus, source)) continue;
      if (!source.regionScoped && !isInRegion(corpus)) continue;
      const location = detectLocation(corpus, source.regionScoped), signature = normalize(title) + '|' + normalize(location);
      if (seen.has(url) || seen.has(signature)) continue;
      seen.add(url); seen.add(signature);
      results.push({ title, url, location, excerpt:context.replace(title, '').replace(/\s+/g, ' ').trim().slice(0, 220), postedLabel:extractDate(context), source:source.name, kind:source.kind });
      if (results.length >= 80) return results;
    }
  }
  return results;
}
function wait(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }
async function fetchReaderPage(source) {
  const start = Math.max(Date.now(), nextReaderStart);
  nextReaderStart = start + MIN_READER_INTERVAL_MS;
  await wait(start - Date.now());
  const response = await fetch(READER + source.url, {
    headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' },
    signal: AbortSignal.timeout(22000)
  });
  if (!response.ok) throw new Error(`Čtečka zdroje odpověděla HTTP ${response.status}`);
  const text = await response.text();
  if (text.length < 100) throw new Error('Zdroj vrátil prázdný výpis');
  return text;
}
async function scanOne(source, keywords) {
  try {
    const page = await fetchReaderPage(source);
    const items = extractCandidates(page, source, keywords);
    return { sourceId:source.id, source:source.name, count:items.length, items };
  } catch (error) {
    return { sourceId:source.id, source:source.name, count:0, items:[], error:error.name === 'TimeoutError' ? 'Vypršel čas načítání' : String(error.message || error).slice(0, 160) };
  }
}
async function scanSources(sourceIds, keywords) {
  const selected = sourceIds.map(id => SOURCE_BY_ID.get(id)).filter(Boolean);
  const summaries = new Array(selected.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= selected.length) return;
      summaries[index] = await scanOne(selected[index], keywords);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, worker));
  const items = summaries.flatMap(summary => summary.items);
  const unique = new Map();
  for (const item of items) {
    const key = item.url || `${normalize(item.title)}|${normalize(item.location)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return { items:[...unique.values()].sort((a,b) => (b.postedLabel ? 1 : 0) - (a.postedLabel ? 1 : 0)), sources:summaries, totalSources:selected.length, completedSources:summaries.filter(s => !s.error).length };
}
function sendHtml(res) {
  try { return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8'); }
  catch { return json(res, 404, { error:'Soubor aplikace nebyl nalezen.' }); }
}
async function handleOnlineApi(req,res,url) {
  try {
    if (req.method==='GET' && url.pathname==='/api/auth/me') {
      const user=await currentUser(req); return user ? json(res,200,{user:publicUser(user)}) : json(res,401,{error:'Nejste přihlášeni.'});
    }
    if (req.method==='POST' && ['/api/auth/register','/api/auth/login'].includes(url.pathname)) {
      if(authRateLimited(req)) return json(res,429,{error:'Příliš mnoho pokusů. Zkuste to za chvíli.'});
      const input=await readJson(req), email=String(input.email||'').trim().toLowerCase(), password=String(input.password||'');
      if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254) return json(res,400,{error:'Zadejte platnou e-mailovou adresu.'});
      if(password.length<10||password.length>200) return json(res,400,{error:'Heslo musí mít 10 až 200 znaků.'});
      let user=dbPool
        ? (await dbPool.query('SELECT id,name,email,role,password_hash AS "passwordHash",salt,created FROM app_users WHERE email=$1',[email])).rows[0]
        : onlineData.users.find(u=>u.email===email);
      if(url.pathname==='/api/auth/register') {
        if(user) return json(res,409,{error:'Účet s tímto e-mailem už existuje. Přihlaste se.'});
        const salt=crypto.randomBytes(16).toString('hex');
        const name=String(input.name||email.split('@')[0]).trim().slice(0,100)||email.split('@')[0];
        const count=dbPool ? Number((await dbPool.query('SELECT COUNT(*) AS count FROM app_users')).rows[0].count) : onlineData.users.length;
        user={id:newId(),name,email,role:count===0?'admin':'user',passwordHash:crypto.scryptSync(password,salt,64).toString('hex'),salt,created:Date.now()};
        if(dbPool) {
          try { await dbPool.query('INSERT INTO app_users(id,name,email,role,password_hash,salt,created) VALUES($1,$2,$3,$4,$5,$6,$7)',[user.id,user.name,user.email,user.role,user.passwordHash,user.salt,user.created]); }
          catch(error) { if(error.code==='23505')return json(res,409,{error:'Účet s tímto e-mailem už existuje. Přihlaste se.'}); throw error; }
        }
        onlineData.users.push(user);
      } else {
        if(!user||crypto.scryptSync(password,user.salt,64).toString('hex')!==user.passwordHash) return json(res,401,{error:'E-mail nebo heslo není správné.'});
        if(!onlineData.users.some(u=>u.id===user.id)) onlineData.users.push(user);
      }
      const token=crypto.randomBytes(32).toString('base64url');
      onlineData.sessions=onlineData.sessions.filter(s=>s.expires>Date.now()&&s.userId!==user.id);
      const session={tokenHash:sha256(token),userId:user.id,expires:Date.now()+30*24*60*60*1000};
      if(dbPool) {
        await dbPool.query('DELETE FROM app_sessions WHERE user_id=$1',[user.id]);
        await dbPool.query('INSERT INTO app_sessions(token_hash,user_id,expires) VALUES($1,$2,$3)',[session.tokenHash,session.userId,session.expires]);
      }
      onlineData.sessions.push(session);
      onlinePresence.set(user.id,Date.now()); saveOnlineData(); setSessionCookie(req,res,token); return json(res,200,{user:publicUser(user)});
    }
    if (req.method==='POST' && url.pathname==='/api/auth/logout') {
      const token=getCookie(req,'zakazkar_session'), tokenHash=sha256(token), session=onlineData.sessions.find(s=>s.tokenHash===tokenHash); if(session)onlinePresence.delete(session.userId); if(dbPool)await dbPool.query('DELETE FROM app_sessions WHERE token_hash=$1',[tokenHash]); onlineData.sessions=onlineData.sessions.filter(s=>s.tokenHash!==tokenHash); saveOnlineData();
      res.setHeader('Set-Cookie','zakazkar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return json(res,200,{ok:true});
    }
    if (url.pathname.startsWith('/api/feed/')) {
      const user=await requireUser(req,res); if(!user) return;
      const match=url.pathname.match(/^\/api\/feed\/posts(?:\/([^/]+)(?:\/(like|comments|share))?)?$/);
      if(!match)return json(res,404,{error:'Nenalezeno.'});
      const [,postId,action]=match;
      const compactPost=(post,allPosts=onlineData.posts)=>{
        const author=onlineData.users.find(u=>u.id===post.authorId)||{name:post.authorName||'Uživatel Zakázkáře'};
        const comments=(post.comments||[]).slice(-20).map(c=>({id:c.id,authorName:c.authorName,text:c.text,ts:c.ts}));
        const shared=post.shareOf?allPosts.find(p=>p.id===post.shareOf):null;
        const sharedAuthor=shared?onlineData.users.find(u=>u.id===shared.authorId):null;
        return {id:post.id,authorId:post.authorId,authorName:post.authorName||author.name,title:post.title||'',body:post.body||'',location:post.location||'',imageUrl:post.imageUrl||'',created:post.created,shareOf:post.shareOf||null,shared:shared?{authorName:shared.authorName||sharedAuthor?.name||'Uživatel Zakázkáře',title:shared.title||'',body:shared.body||'',location:shared.location||'',imageUrl:shared.imageUrl||''}:null,likesCount:(post.likes||[]).length,likedByMe:(post.likes||[]).includes(user.id),commentsCount:(post.comments||[]).length,comments,sharesCount:allPosts.filter(p=>p.shareOf===post.id).length};
      };
      if(req.method==='GET'&&postId===undefined) {
        const posts=await readFeedPosts();
        return json(res,200,{posts:[...posts].sort((a,b)=>b.created-a.created).slice(0,100).map(post=>compactPost(post,posts)),canPost:true});
      }
      if(req.method==='POST'&&postId===undefined) {
        const input=await readJson(req,2*1024*1024),title=String(input.title||'').trim(),body=String(input.body||'').trim(),location=String(input.location||'').trim(),imageUrl=String(input.imageUrl||'').trim();
        if((!title&&!body&&!imageUrl)||title.length>140||body.length>4000||location.length>120)return json(res,400,{error:'Přidejte text, titulek nebo obrázek. Zkontrolujte také délku údajů.'});
        if(imageUrl.startsWith('data:')){if(imageUrl.length>1800000||!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(imageUrl))return json(res,400,{error:'Obrázek je příliš velký nebo má nepodporovaný formát.'});}
        else if(imageUrl){try{const image=new URL(imageUrl);if(!['http:','https:'].includes(image.protocol))throw new Error();}catch{return json(res,400,{error:'Odkaz na obrázek musí být platná adresa HTTP nebo HTTPS.'});}}
        const post={id:newId(),authorId:user.id,authorName:user.name,title,body,location,imageUrl,created:Date.now(),likes:[],comments:[],shareOf:null};await writeFeedPost(post);return json(res,201,{post:compactPost(post)});
      }
      const post=await readFeedPost(postId);if(!post)return json(res,404,{error:'Příspěvek nebyl nalezen.'});
      if(req.method==='POST'&&action==='like'){
        const updated=await updateFeedPost(postId,current=>{current.likes||=[];const index=current.likes.indexOf(user.id);if(index>=0)current.likes.splice(index,1);else current.likes.push(user.id);return {liked:index<0,likesCount:current.likes.length};});
        return updated?json(res,200,updated.result):json(res,404,{error:'Příspěvek nebyl nalezen.'});
      }
      if(req.method==='POST'&&action==='comments'){
        const input=await readJson(req,4*1024),text=String(input.text||'').trim();if(!text||text.length>1000)return json(res,400,{error:'Komentář musí mít 1 až 1 000 znaků.'});
        const updated=await updateFeedPost(postId,current=>{current.comments||=[];const comment={id:newId(),authorId:user.id,authorName:user.name,text,ts:Date.now()};current.comments.push(comment);return {comment:{id:comment.id,authorName:comment.authorName,text:comment.text,ts:comment.ts},commentsCount:current.comments.length};});
        return updated?json(res,201,updated.result):json(res,404,{error:'Příspěvek nebyl nalezen.'});
      }
      if(req.method==='POST'&&action==='share'){
        const input=await readJson(req,4*1024),text=String(input.text||'').trim();if(text.length>1000)return json(res,400,{error:'Text sdílení může mít nejvýše 1 000 znaků.'});
        const repost={id:newId(),authorId:user.id,authorName:user.name,title:'',body:text,location:'',imageUrl:'',created:Date.now(),likes:[],comments:[],shareOf:post.id};await writeFeedPost(repost);return json(res,201,{post:compactPost(repost,[...onlineData.posts,repost])});
      }
    }
    if (url.pathname.startsWith('/api/chat/')) {
      const user=await requireUser(req,res); if(!user) return;
      if(req.method==='GET'&&url.pathname==='/api/chat/users') {
        const query=String(url.searchParams.get('q')||'').trim().toLowerCase();
        if(query.length<2) return json(res,200,{users:[]});
        const found=dbPool
          ? (await dbPool.query('SELECT id,name,email,role FROM app_users WHERE id<>$1 AND (LOWER(email) LIKE $2 OR LOWER(name) LIKE $2) ORDER BY name LIMIT 20',[user.id,`%${query}%`])).rows
          : onlineData.users.filter(u=>u.id!==user.id&&(u.email.includes(query)||u.name.toLowerCase().includes(query))).slice(0,20);
        const users=found.map(u=>({...publicUser(u),online:Date.now()-(onlinePresence.get(u.id)||0)<45000}));
        return json(res,200,{users});
      }
      if(req.method==='GET'&&url.pathname==='/api/chat/threads') {
        const peers=new Map();
        const allMessages=dbPool
          ? (await dbPool.query('SELECT id,sender_id AS "from",recipient_id AS "to",body AS text,created AS ts,read_at AS "readAt" FROM chat_messages WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created DESC LIMIT 5000',[user.id])).rows.map(m=>({...m,ts:Number(m.ts),readAt:m.readAt===null?null:Number(m.readAt)}))
          : onlineData.messages;
        for(const m of allMessages) if(m.from===user.id||m.to===user.id) {
          const peerId=m.from===user.id?m.to:m.from, old=peers.get(peerId)||{peerId,latest:m,unread:0};
          if(m.ts>old.latest.ts) old.latest=m; if(m.to===user.id&&!m.readAt) old.unread++; peers.set(peerId,old);
        }
        const threads=[...peers.values()].map(t=>{const peer=onlineData.users.find(u=>u.id===t.peerId)||{id:t.peerId,name:'Neznámý účet',email:''};return {...t,peer:{...publicUser(peer),online:Date.now()-(onlinePresence.get(peer.id)||0)<45000}};}).sort((a,b)=>b.latest.ts-a.latest.ts);
        return json(res,200,{threads});
      }
      if(req.method==='GET'&&url.pathname==='/api/chat/messages') {
        const peerId=String(url.searchParams.get('with')||'');
        const peerExists=dbPool ? (await dbPool.query('SELECT 1 FROM app_users WHERE id=$1',[peerId])).rowCount>0 : onlineData.users.some(u=>u.id===peerId);
        if(!peerExists||peerId===user.id) return json(res,404,{error:'Účet nebyl nalezen.'});
        const messages=dbPool
          ? (await dbPool.query('SELECT id,sender_id AS "from",recipient_id AS "to",body AS text,created AS ts,read_at AS "readAt" FROM chat_messages WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1) ORDER BY created DESC LIMIT 300',[user.id,peerId])).rows.map(m=>({...m,ts:Number(m.ts),readAt:m.readAt===null?null:Number(m.readAt)})).reverse()
          : onlineData.messages.filter(m=>(m.from===user.id&&m.to===peerId)||(m.from===peerId&&m.to===user.id)).sort((a,b)=>a.ts-b.ts);
        let changed=false; for(const m of messages) if(m.to===user.id&&!m.readAt){m.readAt=Date.now();changed=true;} if(changed)saveOnlineData();
        if(changed&&dbPool) await dbPool.query('UPDATE chat_messages SET read_at=$1 WHERE recipient_id=$2 AND sender_id=$3 AND read_at IS NULL',[Date.now(),user.id,peerId]);
        return json(res,200,{messages:messages.slice(-300).map(m=>({id:m.id,from:m.from,to:m.to,text:m.text,ts:m.ts,readAt:m.readAt||null}))});
      }
      if(req.method==='POST'&&url.pathname==='/api/chat/messages') {
        const input=await readJson(req,8*1024), peerId=String(input.to||''), text=String(input.text||'').trim();
        const peerExists=dbPool ? (await dbPool.query('SELECT 1 FROM app_users WHERE id=$1',[peerId])).rowCount>0 : onlineData.users.some(u=>u.id===peerId);
        if(!peerExists||peerId===user.id) return json(res,404,{error:'Vyberte platného příjemce.'});
        if(!text||text.length>2000) return json(res,400,{error:'Zpráva musí mít 1 až 2 000 znaků.'});
        const message={id:newId(),from:user.id,to:peerId,text,ts:Date.now(),readAt:null};
        if(dbPool) await dbPool.query('INSERT INTO chat_messages(id,sender_id,recipient_id,body,created,read_at) VALUES($1,$2,$3,$4,$5,NULL)',[message.id,message.from,message.to,message.text,message.ts]);
        onlineData.messages.push(message); saveOnlineData();
        return json(res,201,{message:{id:message.id,from:message.from,to:message.to,text:message.text,ts:message.ts,readAt:null}});
      }
    }
    return json(res,404,{error:'Nenalezeno.'});
  } catch(error) { return json(res,error.status||500,{error:error.status?error.message:'Server chat nedokázal zpracovat požadavek.'}); }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (!dbPool) return json(res, 200, { ok:true, version:APP_VERSION, scanner:true, chat:true, database:'local-file', feedStorage:'local-file', sources:SOURCES.length });
    dbPool.query('SELECT 1').then(()=>json(res,200,{ok:true,version:APP_VERSION,scanner:true,chat:true,database:'postgresql',feedStorage:'postgresql',sources:SOURCES.length}))
      .catch(()=>json(res,503,{ok:false,version:APP_VERSION,scanner:true,chat:true,database:'unavailable',feedStorage:'unavailable',sources:SOURCES.length}));
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendHtml(res);
  if (req.method === 'GET' && ['/mobilni-zakazkar.html','/zakazkar-vylepsena.html'].includes(url.pathname)) {
    res.writeHead(301, { Location:'/' }); res.end(); return;
  }
  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/chat/') || url.pathname.startsWith('/api/feed/')) return handleOnlineApi(req,res,url);
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        const keywords = Array.isArray(input.keywords) ? [...new Set(input.keywords.map(value => String(value).trim()).filter(value => value.length >= 2 && value.length <= 80))].slice(0, 80) : [];
        const sourceIds = Array.isArray(input.sourceIds) ? [...new Set(input.sourceIds.map(String))].filter(id => SOURCE_BY_ID.has(id)) : [];
        if (!keywords.length) return json(res, 400, { error:'Nejdříve nastavte obory, které hledáte.' });
        if (!sourceIds.length) return json(res, 400, { error:'Vyberte alespoň jeden zdroj v nastavení portálů.' });
        const result = await scanSources(sourceIds, keywords);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, { error:`Sken se nepodařilo spustit: ${String(error.message || error).slice(0, 160)}` });
      }
    });
    return;
  }
  return json(res, 404, { error:'Nenalezeno.' });
});
initializeDatabase().then(()=>{
  if(!dbPool) console.warn('DATABASE_URL není nastaveno; účty a zprávy se ukládají jen do místního souboru.');
  server.listen(PORT, HOST, () => console.log(JSON.stringify({ ok:true, scanner:true, database:dbPool?'postgresql':'local-file', sources:SOURCES.length, app:`http://${HOST}:${PORT}/` })));
}).catch(error=>{console.error('Databázi se nepodařilo připravit: '+error.message);process.exit(1);});
server.on('error', error => { console.error('Zakázkář server: ' + error.message); process.exit(1); });
