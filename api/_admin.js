'use strict';
/* ============================================================
 * The admin door (Kate, Sep 23, 2026)
 * ============================================================
 * A password-protected way to edit the Exchange's items from the site
 * itself, and to pin items or add one-off cards to New & upcoming. Each save
 * is a commit to this repo on GitHub, so it goes live with the next deploy
 * (about a minute), and every change sits in the history, where it can be
 * undone.
 *
 * Set in Vercel (Project > Settings > Environment Variables), never here:
 *   ADMIN_PASSWORD   the password Kate chose
 *   GITHUB_TOKEN     a fine-grained token for this repo only, with
 *                    Contents: read and write
 * Optional:
 *   ADMIN_SESSION_SECRET  signs the sign-in cookie (default: derived from
 *                         the password, so changing it signs everyone out)
 *   GITHUB_REPO           default kateb-123/erc-policy-exchange-app
 *   GITHUB_BRANCH         default main
 *   ADMIN_COMMIT_EMAIL    default kl.barnestn@gmail.com (Vercel skips
 *                         commits authored with her tamu.edu address)
 *
 * Files in api/ whose names start with "_" are not routes; the four routes
 * in api/admin/ are thin wrappers around the handlers at the bottom.
 * ============================================================ */
const crypto = require('crypto');

const SESSION_COOKIE = 'exa_admin'; // HttpOnly: the sign-in itself
const HINT_COOKIE = 'exa_admin_on'; // readable: tells the page to load the editor
const SESSION_SECONDS = 12 * 60 * 60;
const CSV_PATH = 'data/news.csv';
const FEATURED_PATH = 'data/featured.json';
const COLUMNS = [
  'date', 'headline', 'link', 'type', 'subtype', 'source', 'topic', 'blurb',
  'deadline', 'medium', 'authors', 'time', 'location', 'infographic',
];
const TYPES = ['research', 'event', 'opportunity', 'headline'];
const MAX_FIELD = 6000;

class BadRequest extends Error {}
class Conflict extends Error {}

/* ---------- Sign-in ---------- */

const sessionSecret = (env) =>
  env.ADMIN_SESSION_SECRET ||
  (env.ADMIN_PASSWORD
    ? crypto.createHash('sha256').update(`exchange-admin-session:${env.ADMIN_PASSWORD}`).digest('hex')
    : '');

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  return payload;
}

// Both sides are hashed first, so the comparison takes the same time
// whatever the lengths and its timing gives nothing away.
function passwordMatches(given, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* a cookie that isn't ours */
    }
  });
  return out;
}

const signedIn = (req, env) => !!verify(readCookies(req)[SESSION_COOKIE], sessionSecret(env));

// Changes come only from pages on this site. The session cookie is
// SameSite=Strict as well; this is the second lock on the same door.
function fromThisSite(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const from = req.headers.origin || req.headers.referer;
  if (!host || !from) return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
}

function sessionCookies(secret, now = Date.now()) {
  const token = sign({ exp: Math.floor(now / 1000) + SESSION_SECONDS }, secret);
  const attrs = `Path=/; Max-Age=${SESSION_SECONDS}; Secure; SameSite=Strict`;
  return [`${SESSION_COOKIE}=${token}; HttpOnly; ${attrs}`, `${HINT_COOKIE}=1; ${attrs}`];
}

const clearedCookies = () =>
  [SESSION_COOKIE, HINT_COOKIE].map((name) => `${name}=; Path=/; Max-Age=0; Secure; SameSite=Strict`);

/* ---------- news.csv ---------- */

// The same reading as js/csv.js (quotes, doubled quotes, commas and line
// breaks inside quotes, CR ignored outside them), but each record keeps its
// exact place in the text. The file mixes \r\n and \n line endings, so a
// save rewrites only the row it changes and leaves every other byte alone.
function csvRecords(text) {
  const recs = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      recs.push({ start, end: i + 1, cells: row });
      row = [];
      field = '';
      start = i + 1;
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    recs.push({ start, end: text.length, cells: row });
  }
  return recs;
}

const rowOf = (header, cells) =>
  Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));

// An item's key: its link, or its title and date when it has none. Pins and
// hidden items are kept by this key.
const keyOf = (row) => (row.link || '').trim() || `${(row.headline || '').trim()}|${(row.date || '').trim()}`;

const quoteCell = (v) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const lineFor = (header, row, ending) => header.map((h) => quoteCell(String(row[h] ?? ''))).join(',') + ending;
const endingOf = (text, rec) =>
  text.slice(rec.end - 2, rec.end) === '\r\n' ? '\r\n' : text[rec.end - 1] === '\n' ? '\n' : '';

function csvHeader(text) {
  const recs = csvRecords(text);
  if (!recs.length) throw new Error('news.csv is empty.');
  return { recs, header: recs[0].cells.map((h) => h.trim()) };
}

// The row as the page last saw it has to still be there, word for word;
// otherwise someone else changed it meanwhile and this save would undo that.
function findRow(text, original) {
  const { recs, header } = csvHeader(text);
  for (const rec of recs.slice(1)) {
    if (rec.cells.length === 1 && rec.cells[0].trim() === '') continue;
    const row = rowOf(header, rec.cells);
    if (header.every((h) => row[h] === String((original || {})[h] ?? '').trim())) return { header, rec, row };
  }
  throw new Conflict('This item changed since the page loaded. Reload the page and try again.');
}

function cleanFields(fields) {
  const out = {};
  for (const k of COLUMNS) {
    if (!(k in (fields || {}))) continue;
    const v = String(fields[k] ?? '').replace(/\r\n?/g, '\n').trim();
    if (v.length > MAX_FIELD) throw new BadRequest(`The ${k} is too long.`);
    out[k] = v;
  }
  if ('headline' in out && !out.headline) throw new BadRequest('An item needs a title.');
  if ('type' in out && !TYPES.includes(out.type)) throw new BadRequest('Pick a section.');
  for (const k of ['link', 'infographic']) {
    if (out[k] && !/^https?:\/\/\S+$/i.test(out[k])) {
      throw new BadRequest(`The ${k === 'link' ? 'link' : 'picture link'} needs to start with http:// or https://.`);
    }
  }
  if (out.date && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(out.date)) {
    throw new BadRequest('Write the date as 2026-10-01.');
  }
  return out;
}

function editRow(text, original, fields) {
  const hit = findRow(text, original);
  const changes = cleanFields(fields);
  const after = { ...hit.row, ...changes };
  const line = lineFor(hit.header, after, endingOf(text, hit.rec));
  return {
    text: text.slice(0, hit.rec.start) + line + text.slice(hit.rec.end),
    before: hit.row,
    after,
    message: `Admin: edit "${after.headline}"`,
  };
}

function deleteRow(text, original) {
  const hit = findRow(text, original);
  return {
    text: text.slice(0, hit.rec.start) + text.slice(hit.rec.end),
    before: hit.row,
    after: null,
    message: `Admin: delete "${hit.row.headline}"`,
  };
}

/* ---------- featured.json: pins, one-off cards, hidden items ---------- */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function readFeatured(text) {
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }
  return {
    pins: Array.isArray(j.pins) ? j.pins : [],
    cards: Array.isArray(j.cards) ? j.cards : [],
    hidden: Array.isArray(j.hidden) ? j.hidden : [],
  };
}

const short = (v, max, what) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new BadRequest(`The ${what} is too long.`);
  return s;
};

function applyFeatured(f, op, body) {
  const key = short(body.key, 2000, 'item key');
  if (['pin', 'unpin', 'hide', 'unhide'].includes(op) && !key) throw new BadRequest('Which item?');
  if (op === 'pin') {
    if (!ISO_DAY.test(String(body.until || ''))) throw new BadRequest('Pick the last day to keep it pinned.');
    f.pins = f.pins.filter((p) => p.key !== key);
    f.pins.unshift({ key, until: body.until });
    return `Admin: pin an item until ${body.until}`;
  }
  if (op === 'unpin') {
    f.pins = f.pins.filter((p) => p.key !== key);
    return 'Admin: unpin an item';
  }
  if (op === 'hide') {
    if (!f.hidden.includes(key)) f.hidden.push(key);
    return 'Admin: hide an item';
  }
  if (op === 'unhide') {
    f.hidden = f.hidden.filter((k) => k !== key);
    return 'Admin: show a hidden item again';
  }
  if (op === 'card') {
    const c = body.card || {};
    const card = {
      id: `c${crypto.randomBytes(4).toString('hex')}`,
      headline: short(c.headline, 300, 'title'),
      link: short(c.link, 2000, 'link'),
      blurb: short(c.blurb, 1000, 'summary'),
      image: short(c.image, 2000, 'picture link'),
      label: short(c.label, 40, 'label'),
      until: String(c.until || ''),
    };
    if (!card.headline) throw new BadRequest('A card needs a title.');
    for (const k of ['link', 'image']) {
      if (card[k] && !/^https?:\/\/\S+$/i.test(card[k])) {
        throw new BadRequest(`The ${k === 'link' ? 'link' : 'picture link'} needs to start with http:// or https://.`);
      }
    }
    if (!ISO_DAY.test(card.until)) throw new BadRequest('Pick the last day to show the card.');
    f.cards.unshift(card);
    return `Admin: add a card "${card.headline}"`;
  }
  if (op === 'uncard') {
    const id = String(body.id || '');
    f.cards = f.cards.filter((c) => c.id !== id);
    return 'Admin: remove a card';
  }
  throw new BadRequest('Unknown change.');
}

// An edit that changes an item's link (its key) carries its pin and its
// hiding along with it.
function rekeyFeatured(f, from, to) {
  let changed = false;
  f.pins.forEach((p) => {
    if (p.key === from) {
      p.key = to;
      changed = true;
    }
  });
  f.hidden = f.hidden.map((k) => {
    if (k !== from) return k;
    changed = true;
    return to;
  });
  return changed;
}

/* ---------- GitHub ---------- */

function github(env, fetchImpl = globalThis.fetch) {
  const repo = env.GITHUB_REPO || 'kateb-123/erc-policy-exchange-app';
  const branch = env.GITHUB_BRANCH || 'main';
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'erc-policy-exchange-admin',
  };
  const url = (path) => `https://api.github.com/repos/${repo}/contents/${path}`;
  return {
    ready: !!env.GITHUB_TOKEN,
    async get(path) {
      const r = await fetchImpl(`${url(path)}?ref=${encodeURIComponent(branch)}`, { headers });
      if (r.status === 404) return { text: null, sha: null };
      if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
      const j = await r.json();
      if (typeof j.content === 'string' && j.encoding === 'base64' && j.content) {
        return { text: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
      }
      // Files over 1 MB come back without inline content.
      const raw = await fetchImpl(`${url(path)}?ref=${encodeURIComponent(branch)}`, {
        headers: { ...headers, Accept: 'application/vnd.github.raw' },
      });
      if (!raw.ok) throw new Error(`GitHub read ${path}: ${raw.status}`);
      return { text: await raw.text(), sha: j.sha };
    },
    async put(path, text, sha, message) {
      const who = { name: 'Kate Barnes', email: env.ADMIN_COMMIT_EMAIL || 'kl.barnestn@gmail.com' };
      const r = await fetchImpl(url(path), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: Buffer.from(text, 'utf8').toString('base64'),
          branch,
          author: who,
          committer: who,
          ...(sha ? { sha } : {}),
        }),
      });
      if (r.status === 409 || r.status === 422) {
        const e = new Error('stale');
        e.stale = true;
        throw e;
      }
      if (!r.ok) throw new Error(`GitHub write ${path}: ${r.status}`);
      return (await r.json()).commit.sha;
    },
  };
}

// Read, change, write; if the file moved on in between (another save, the
// desk's Publish), start again from the new copy.
async function withFile(gh, path, change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await gh.get(path);
    const result = change(text);
    if (result.same) return result; // nothing to write
    try {
      const commit = await gh.put(path, result.text, sha, result.message);
      return { ...result, commit };
    } catch (err) {
      if (!err.stale) throw err;
    }
  }
  throw new Error(`${path} kept changing while saving.`);
}

/* ---------- HTTP ---------- */

function send(res, status, body, cookies) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (cookies) res.setHeader('Set-Cookie', cookies);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200000) throw new BadRequest('That change is too big.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleLogin(req, res, { env = process.env, pause = wait } = {}) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  if (!env.ADMIN_PASSWORD) {
    return send(res, 503, { ok: false, error: "The admin door isn't set up yet: its password goes in Vercel's settings." });
  }
  if (!fromThisSite(req)) return send(res, 403, { ok: false, error: 'Sign in from the site itself.' });
  const body = await readBody(req);
  if (!passwordMatches(body.password, env.ADMIN_PASSWORD)) {
    // A wrong password costs a second and a half, which makes guessing slow.
    await pause(1500);
    return send(res, 401, { ok: false, error: "That password isn't right." });
  }
  return send(res, 200, { ok: true }, sessionCookies(sessionSecret(env)));
}

function handleSession(req, res, { env = process.env } = {}) {
  return send(res, 200, { ok: signedIn(req, env) });
}

function handleLogout(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  return send(res, 200, { ok: true }, clearedCookies());
}

async function handleSave(req, res, { env = process.env, gh = github(env) } = {}) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  if (!fromThisSite(req)) return send(res, 403, { ok: false, error: 'Save from the site itself.' });
  if (!signedIn(req, env)) return send(res, 401, { ok: false, error: 'Your sign-in ran out. Sign in again.' });
  if (!gh.ready) {
    return send(res, 503, { ok: false, error: "The admin door can't save yet: its GitHub key goes in Vercel's settings." });
  }
  try {
    const body = await readBody(req);
    const op = String(body.op || '');
    if (op === 'edit' || op === 'delete') {
      const out = await withFile(gh, CSV_PATH, (text) => {
        if (text === null) throw new Error('news.csv is missing.');
        return op === 'edit' ? editRow(text, body.original, body.fields) : deleteRow(text, body.original);
      });
      let featured = null;
      if (out.after && keyOf(out.before) !== keyOf(out.after)) {
        const moved = await withFile(gh, FEATURED_PATH, (text) => {
          const f = readFeatured(text);
          if (!rekeyFeatured(f, keyOf(out.before), keyOf(out.after))) return { featured: f, same: true };
          return { text: `${JSON.stringify(f, null, 2)}\n`, message: 'Admin: move a pin to an edited link', featured: f };
        }).catch(() => null);
        featured = moved ? moved.featured : null;
      }
      return send(res, 200, { ok: true, row: out.after, featured });
    }
    const out = await withFile(gh, FEATURED_PATH, (text) => {
      const f = readFeatured(text);
      const message = applyFeatured(f, op, body);
      return { text: `${JSON.stringify(f, null, 2)}\n`, message, featured: f };
    });
    return send(res, 200, { ok: true, featured: out.featured });
  } catch (err) {
    if (err instanceof BadRequest) return send(res, 400, { ok: false, error: err.message });
    if (err instanceof Conflict) return send(res, 409, { ok: false, error: err.message });
    console.error('admin save failed', err);
    return send(res, 502, { ok: false, error: "Couldn't save to GitHub just now. Try again in a minute." });
  }
}

module.exports = {
  COLUMNS,
  SESSION_COOKIE,
  HINT_COOKIE,
  BadRequest,
  Conflict,
  sign,
  verify,
  passwordMatches,
  readCookies,
  fromThisSite,
  sessionCookies,
  sessionSecret,
  csvRecords,
  keyOf,
  findRow,
  cleanFields,
  editRow,
  deleteRow,
  readFeatured,
  applyFeatured,
  rekeyFeatured,
  github,
  withFile,
  handleLogin,
  handleSession,
  handleLogout,
  handleSave,
};
