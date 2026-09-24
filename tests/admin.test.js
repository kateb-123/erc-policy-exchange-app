// Tests for the admin door's server code (api/_admin.js). Run from the repo: node tests/admin.test.js
// No network: GitHub is a fake that holds copies of the files.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const A = require(path.join(__dirname, '../api/_admin.js'));
const csv = fs.readFileSync(path.join(__dirname, '../data/news.csv'), 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const okA = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// The page's own parser, to get "original" rows exactly as the browser sees them.
const vm = require('vm'); const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/csv.js'), 'utf8') + '\nthis.parseCSV = parseCSV;', ctx);
const rows = ctx.parseCSV(csv);

ok('records match the page parser', () => {
  const recs = A.csvRecords(csv);
  const header = recs[0].cells.map((h) => h.trim());
  const live = recs.slice(1).filter((r) => !(r.cells.length === 1 && r.cells[0].trim() === ''));
  assert.strictEqual(live.length, rows.length);
  live.forEach((r, i) => header.forEach((h, j) => assert.strictEqual((r.cells[j] ?? '').trim(), rows[i][h])));
});
ok('records cover the file exactly', () => {
  const recs = A.csvRecords(csv);
  assert.strictEqual(recs.map((r) => csv.slice(r.start, r.end)).join(''), csv);
});
ok('edit rewrites one row and nothing else', () => {
  let tested = 0;
  for (const i of [0, 5, 60, rows.length - 1]) {
    const orig = rows[i];
    const out = A.editRow(csv, orig, { headline: orig.headline + ' (edited, "quoted")', blurb: 'Line one,\nline two' });
    const recs = A.csvRecords(csv); const hit = A.findRow(csv, orig).rec;
    assert.strictEqual(out.text.slice(0, hit.start), csv.slice(0, hit.start));
    const tail = csv.slice(hit.end); assert.ok(out.text.endsWith(tail));
    const again = ctx.parseCSV(out.text);
    assert.strictEqual(again.length, rows.length);
    assert.strictEqual(again[i].headline, orig.headline + ' (edited, "quoted")');
    assert.strictEqual(again[i].blurb, 'Line one,\nline two');
    for (const h of Object.keys(orig)) if (!['headline', 'blurb'].includes(h)) assert.strictEqual(again[i][h], orig[h]);
    again.forEach((r, j) => { if (j !== i) assert.deepStrictEqual(r, rows[j]); });
    tested++;
  }
  assert.strictEqual(tested, 4);
});
ok('delete removes one row', () => {
  const out = A.deleteRow(csv, rows[3]);
  const again = ctx.parseCSV(out.text);
  assert.strictEqual(again.length, rows.length - 1);
  assert.deepStrictEqual(again[3], rows[4]);
});
ok('a changed row is a conflict', () => {
  assert.throws(() => A.editRow(csv, { ...rows[2], headline: 'not what is there' }, { blurb: 'x' }), A.Conflict);
});
ok('fields are checked', () => {
  assert.throws(() => A.cleanFields({ headline: '' }), A.BadRequest);
  assert.throws(() => A.cleanFields({ type: 'news' }), A.BadRequest);
  assert.throws(() => A.cleanFields({ link: 'javascript:alert(1)' }), A.BadRequest);
  assert.throws(() => A.cleanFields({ date: 'Oct 1' }), A.BadRequest);
  assert.deepStrictEqual(A.cleanFields({ date: '2026-10', notacolumn: 'x', headline: ' T ' }), { date: '2026-10', headline: 'T' });
});
ok('passwords compare', () => {
  assert.ok(A.passwordMatches('correct horse', 'correct horse'));
  assert.ok(!A.passwordMatches('correct hors', 'correct horse'));
  assert.ok(!A.passwordMatches('', ''));
  assert.ok(!A.passwordMatches(undefined, 'x'));
});
ok('session tokens sign, expire and resist tampering', () => {
  const t = A.sign({ exp: Math.floor(Date.now() / 1000) + 60 }, 's3cret');
  assert.ok(A.verify(t, 's3cret'));
  assert.ok(!A.verify(t, 'other'));
  assert.ok(!A.verify(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 's3cret'));
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url') + '.' + mac;
  assert.ok(!A.verify(forged, 's3cret'));
  assert.ok(!A.verify(A.sign({ exp: 1 }, 's3cret'), 's3cret'));
  assert.ok(!A.verify('garbage', 's3cret'));
});
ok('only this site may write', () => {
  assert.ok(A.fromThisSite({ headers: { host: 'x.vercel.app', origin: 'https://x.vercel.app' } }));
  assert.ok(!A.fromThisSite({ headers: { host: 'x.vercel.app', origin: 'https://evil.example' } }));
  assert.ok(!A.fromThisSite({ headers: { host: 'x.vercel.app' } }));
});
ok('featured changes', () => {
  const f = A.readFeatured('');
  A.applyFeatured(f, 'pin', { key: 'https://a', until: '2026-10-10' });
  A.applyFeatured(f, 'pin', { key: 'https://a', until: '2026-10-12' });
  assert.deepStrictEqual(f.pins, [{ key: 'https://a', until: '2026-10-12' }]);
  A.applyFeatured(f, 'hide', { key: 'https://b' }); A.applyFeatured(f, 'hide', { key: 'https://b' });
  assert.deepStrictEqual(f.hidden, ['https://b']);
  A.applyFeatured(f, 'card', { card: { headline: 'Hi', until: '2026-10-01', link: 'https://c' } });
  assert.strictEqual(f.cards.length, 1); assert.ok(/^c[0-9a-f]{8}$/.test(f.cards[0].id));
  assert.throws(() => A.applyFeatured(f, 'card', { card: { headline: 'x', until: 'soon' } }), A.BadRequest);
  assert.throws(() => A.applyFeatured(f, 'card', { card: { headline: 'x', until: '2026-10-01', image: 'data:x' } }), A.BadRequest);
  assert.throws(() => A.applyFeatured(f, 'drop-table', {}), A.BadRequest);
  A.applyFeatured(f, 'uncard', { id: f.cards[0].id }); assert.strictEqual(f.cards.length, 0);
  // Her hero card templates: the choice and its own fields ride along, checked.
  A.applyFeatured(f, 'card', { card: { headline: 'A quote', until: '2026-10-01', hero: 'quote', who: 'Speaker name', role: 'Title, Organization' } });
  assert.deepStrictEqual([f.cards[0].hero, f.cards[0].who, f.cards[0].role], ['quote', 'Speaker name', 'Title, Organization']);
  A.applyFeatured(f, 'card', { card: { headline: 'Plain', until: '2026-10-01' } });
  assert.deepStrictEqual([f.cards[0].hero, f.cards[0].who, f.cards[0].role, f.cards[0].figure], ['', '', '', '']);
  assert.throws(() => A.applyFeatured(f, 'card', { card: { headline: 'x', until: '2026-10-01', hero: 'banner' } }), A.BadRequest);
  assert.throws(() => A.applyFeatured(f, 'card', { card: { headline: 'x', until: '2026-10-01', hero: 'quote', who: 'w'.repeat(121) } }), A.BadRequest);
  f.cards = [];
  assert.ok(A.rekeyFeatured(f, 'https://a', 'https://a2')); assert.strictEqual(f.pins[0].key, 'https://a2');
});

// Handlers, with a fake GitHub holding copies of the files.
function fakeGh(files) {
  const sha = (t) => require('crypto').createHash('sha1').update(t).digest('hex');
  return { ready: true, files, writes: [],
    async get(p) { return p in files ? { text: files[p], sha: sha(files[p]) } : { text: null, sha: null }; },
    async put(p, text, s, message) { if ((p in files ? sha(files[p]) : null) !== (s || null)) { const e = new Error('stale'); e.stale = true; throw e; } files[p] = text; this.writes.push({ p, message }); return 'abc123'; } };
}
function call(handler, { method = 'POST', headers = {}, body, deps }) {
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(b) }); } };
    handler({ method, headers: { host: 'x.test', origin: 'http://x.test', ...headers }, body }, res, deps);
  });
}
(async () => {
  const env = { ADMIN_PASSWORD: 'a long test passphrase', GITHUB_TOKEN: 'unused' };
  await okA('login: unset door, wrong, right', async () => {
    let r = await call(A.handleLogin, { body: { password: 'x' }, deps: { env: {}, pause: async () => {} } });
    assert.strictEqual(r.status, 503);
    r = await call(A.handleLogin, { body: { password: 'wrong' }, deps: { env, pause: async () => {} } });
    assert.strictEqual(r.status, 401); assert.ok(!r.headers['set-cookie']);
    r = await call(A.handleLogin, { headers: { origin: 'https://evil.example' }, body: { password: env.ADMIN_PASSWORD }, deps: { env, pause: async () => {} } });
    assert.strictEqual(r.status, 403);
    r = await call(A.handleLogin, { body: { password: env.ADMIN_PASSWORD }, deps: { env, pause: async () => {} } });
    assert.strictEqual(r.status, 200);
    const c = r.headers['set-cookie']; assert.ok(/exa_admin=[^;]+; HttpOnly; Path=\/; Max-Age=600; Secure; SameSite=Strict/.test(c[0])); assert.ok(/^exa_admin_on=1;/.test(c[1]));
  });
  const login = await call(A.handleLogin, { body: { password: env.ADMIN_PASSWORD }, deps: { env, pause: async () => {} } });
  const cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  await okA('save: needs the sign-in and this site', async () => {
    const gh = fakeGh({ 'data/news.csv': csv });
    let r = await call(A.handleSave, { body: { op: 'hide', key: 'k' }, deps: { env, gh } });
    assert.strictEqual(r.status, 401);
    r = await call(A.handleSave, { headers: { cookie: 'exa_admin=forged.token' }, body: { op: 'hide', key: 'k' }, deps: { env, gh } });
    assert.strictEqual(r.status, 401);
    r = await call(A.handleSave, { headers: { cookie, origin: 'https://evil.example' }, body: { op: 'hide', key: 'k' }, deps: { env, gh } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(gh.writes.length, 0);
  });
  await okA('save: edit, then a stale edit, then pin, card, delete', async () => {
    const gh = fakeGh({ 'data/news.csv': csv });
    let r = await call(A.handleSave, { headers: { cookie }, body: { op: 'edit', original: rows[1], fields: { headline: 'New title' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.row.headline, 'New title');
    assert.strictEqual(ctx.parseCSV(gh.files['data/news.csv'])[1].headline, 'New title');
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'edit', original: rows[1], fields: { headline: 'Again' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 409);
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'pin', key: A.keyOf(rows[2]), until: '2026-10-15' }, deps: { env, gh } });
    assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(gh.files['data/featured.json']).pins[0].key, A.keyOf(rows[2]));
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'edit', original: rows[2], fields: { link: 'https://example.org/moved' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(gh.files['data/featured.json']).pins[0].key, 'https://example.org/moved');
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'card', card: { headline: 'A card', until: '2026-10-20' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.featured.cards.length, 1);
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'delete', original: rows[4] }, deps: { env, gh } });
    assert.strictEqual(r.status, 200); assert.strictEqual(ctx.parseCSV(gh.files['data/news.csv']).length, rows.length - 1);
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'edit', original: rows[5], fields: { type: 'blog' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 400);
    assert.ok(gh.writes.every((w) => w.message.startsWith('Admin: ')));
  });
  await okA('login: a short password keeps the door shut', async () => {
    const shortEnv = { ADMIN_PASSWORD: 'short one', GITHUB_TOKEN: 'x' };
    let r = await call(A.handleLogin, { body: { password: 'short one' }, deps: { env: shortEnv, pause: async () => {} } });
    assert.strictEqual(r.status, 503);
    r = await call(A.handleSession, { method: 'GET', headers: { cookie }, deps: { env: shortEnv } });
    assert.strictEqual(r.body.ok, false);
  });
  await okA('save: a damaged pins file is never saved over', async () => {
    const gh = fakeGh({ 'data/news.csv': csv, 'data/featured.json': '{"pins": [ <<<<<<< HEAD' });
    const r = await call(A.handleSave, { headers: { cookie }, body: { op: 'hide', key: 'k' }, deps: { env, gh } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(gh.files['data/featured.json'], '{"pins": [ <<<<<<< HEAD');
  });
  await okA('save: changing a card is one checked write', async () => {
    const gh = fakeGh({ 'data/news.csv': csv });
    let r = await call(A.handleSave, { headers: { cookie }, body: { op: 'card', card: { headline: 'First', until: '2026-10-20' } }, deps: { env, gh } });
    const id = r.body.featured.cards[0].id;
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'card', replace: id, card: { headline: 'Bad', until: '2026-10-20', image: 'ftp://x' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(JSON.parse(gh.files['data/featured.json']).cards[0].headline, 'First');
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'card', replace: id, card: { headline: 'Second', until: '2026-10-21' } }, deps: { env, gh } });
    const cards = JSON.parse(gh.files['data/featured.json']).cards;
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(cards.map((c) => [c.id, c.headline]), [[id, 'Second']]);
    r = await call(A.handleSave, { headers: { cookie }, body: { op: 'card', replace: 'cgone', card: { headline: 'X', until: '2026-10-21' } }, deps: { env, gh } });
    assert.strictEqual(r.status, 409);
  });
  await okA('save: no GitHub key yet', async () => {
    const r = await call(A.handleSave, { headers: { cookie }, body: { op: 'hide', key: 'k' }, deps: { env, gh: { ready: false } } });
    assert.strictEqual(r.status, 503);
  });
  await okA('session and logout; checks and saves renew the 10 minutes', async () => {
    let r = await call(A.handleSession, { method: 'GET', headers: { cookie }, deps: { env } }); assert.strictEqual(r.body.ok, true);
    assert.ok(/^exa_admin=[^;]+; HttpOnly; Path=\/; Max-Age=600;/.test(r.headers['set-cookie'][0]));
    const s = await call(A.handleSave, { headers: { cookie }, body: { op: 'hide', key: 'k' }, deps: { env, gh: fakeGh({ 'data/news.csv': csv }) } });
    assert.strictEqual(s.status, 200); assert.ok(/Max-Age=600/.test([].concat(s.headers['set-cookie'])[0]));
    const expired = A.sign({ exp: Math.floor(Date.now() / 1000) - 1 }, A.sessionSecret(env));
    r = await call(A.handleSession, { method: 'GET', headers: { cookie: `exa_admin=${expired}` }, deps: { env } }); assert.strictEqual(r.body.ok, false);
    r = await call(A.handleSession, { method: 'GET', deps: { env } }); assert.strictEqual(r.body.ok, false);
    r = await call(A.handleLogout, {}); assert.ok(r.headers['set-cookie'].every((c) => /Max-Age=0/.test(c)));
  });
  console.log(n, 'tests passed');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
