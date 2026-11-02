// Self-check: node check.mjs  (starts the server on a spare port, asserts, stops it)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { I18N, ZH_TAX } = new Function(fs.readFileSync('i18n.js', 'utf8') + ';return {I18N,ZH_TAX}')();
const tax = JSON.parse(fs.readFileSync('data/hackertube-data/taxonomy.json', 'utf8'));

// i18n parity
const en = Object.keys(I18N.en).sort(), zh = Object.keys(I18N.zh).sort();
assert.deepEqual(en, zh, 'en/zh key sets differ');
for (const [k, v] of Object.entries(I18N.zh)) assert.ok(v.trim(), `empty zh value: ${k}`);
// every t('key') used by index.html exists (plural bases via _one)
const html = fs.readFileSync('index.html', 'utf8');
for (const [, k] of html.matchAll(/\bt\('([\w.-]+)'[,)]/g)) assert.ok(k in I18N.en || `${k}_one` in I18N.en, `index.html uses missing key ${k}`);
const enums = { type: values('content_type'), level: values('level'), shelf: ['evergreen', 'dated', 'news'], stance: ['strong_rec', 'rec', 'reference', 'joke', 'critical'],
  reason: ['classic', 'gem', 'gem_meta', 'recent', 'random', 'unexplored', 'similar', 'hn'], kind: ['start', 'curriculum', 'journey', 'mood', 'canon', 'deep-dive'], sort: ['relevance', 'hn', 'recent', 'date', 'old', 'views', 'liked'],
  dur: ['short', 'medium', 'long', 'xlong'], date: ['year', '2020s', '2010s', '2000s'] };
for (const [p, ks] of Object.entries(enums)) for (const k of ks) assert.ok(`${p}.${k}` in I18N.en, `missing ${p}.${k}`);
function values(f) { // distinct values of a videos.jsonl field
  return [...new Set(fs.readFileSync('data/hackertube-data/videos.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l)[f]))];
}
// taxonomy names
const areas = tax.areas, cats = areas.flatMap((a) => a.categories);
assert.equal(areas.length, 16); assert.equal(cats.length, 150);
for (const x of [...areas, ...cats]) assert.ok(ZH_TAX[x.id]?.trim(), `no zh name for ${x.id}`);
console.log(`i18n ok: ${en.length} keys, ${areas.length} areas, ${cats.length} categories`);

// client script compiles (not run)
new Function(html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/<\/?script>/g, ''));

// ---------- API ----------
const rd = (f) => fs.readFileSync('data/' + f, 'utf8');
const V = rd('hackertube-data/videos.jsonl').trim().split('\n').map((l) => JSON.parse(l));
const rel = rd('hackertube-data/related.jsonl').trim().split('\n').map((l) => JSON.parse(l));
const canon = JSON.parse(rd('playlists-full.json')).find((p) => p.slug === 'hn-canon').videos.map((x) => x.vid);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-check-'));

// fixture picks: G1 is in the hn-canon playlist, G2 is a related-neighbour of RH, G3 is private; P[0..] get varied metadata
const G1 = canon[0], rr = rel.find((r) => r.related.length && r.vid !== G1 && r.related[0].vid !== G1 && r.related[0].vid !== 'fNk_zzaMoSs' && r.vid !== 'fNk_zzaMoSs');
const G2 = rr.related[0].vid, RH = rr.vid;
const skip = new Set([G1, G2, RH, 'fNk_zzaMoSs']);
const G3 = V.find((v) => !skip.has(v.vid)).vid; skip.add(G3);
const P = V.filter((v) => !skip.has(v.vid)).slice(0, 13).map((v) => v.vid);
const now = Date.now(), iso = (s) => new Date(s).toISOString(), ago = (d) => new Date(now - d * 864e5).toISOString();
const row = (i, duration_s, views, likes, published, embeddable = true) => ({ vid: P[i], published, duration_s, views, likes, embeddable, privacy: 'public' });
const rows = [{ vid: G1, gone: true }, { vid: G2, gone: true }, { ...row(0, 100, 1, 1, '2020-01-01T00:00:00Z'), vid: G3, privacy: 'private' },
  row(2, null, null, null, iso('2019-06-01')),          // all-null stats, still has an upload date
  row(3, 100, 500, 50, iso('2005-05-05'), false),        // short, embedding disabled
  row(4, 600, 50000, 500, iso('2015-05-05')),            // medium
  row(5, 1800, 2000, 1000, iso('2022-05-05')),           // long, ratio .5
  row(6, 7200, 1e6, 20000, iso('2012-05-05')),           // xlong, ratio .02
  row(7, 7200, 999, 999, ago(10)),                       // xlong, views < 1000: no like ratio, past year
  row(8, 240, 99999, null, iso('2021-05-05')),           // medium boundary, null likes
  row(9, 3600, 1e5, 5000, iso('2009-05-05')),            // long boundary, not a gem (100000 views)
  row(10, 1200, 3, 1, iso('2018-05-05')),                // long boundary
  row(11, 3601, 150000, 30000, iso('2023-05-05')),       // xlong boundary, ratio .2
  row(12, 239, 10, 1, iso('2001-05-05'))];               // short boundary
const fixture = path.join(tmp, 'meta.jsonl');
fs.writeFileSync(fixture, rows.map((r) => JSON.stringify(r)).join('\n') + '\n\n{"vid":"trunc'); // blank + truncated line must be tolerated
const absent = path.join(tmp, 'absent.jsonl');
const Pset = (...i) => new Set(i.map((k) => P[k]));
const same = (items, set, msg) => assert.deepEqual(new Set(items.map((x) => x.vid)), set, msg);

async function suite(name, env, fn) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, ...env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => { srv.stdout.once('data', res); srv.once('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server timeout')), 20000); });
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return [r.status, r.headers.get('content-type'), await r.text()]; };
    const j = async (p, st = 200) => { const [s, , b] = await get(p); assert.equal(s, st, `${p} -> ${s}`); return JSON.parse(b); };
    await fn(j, get);
    console.log(`api ok (${name})`);
  } finally { srv.kill(); }
}

// gone: number of videos removed; pl: hn-canon items expected
async function common(j, get, gone, pl) {
  const stats = await j('/api/stats'); assert.equal(stats.videos, 6454 - gone); assert.equal(stats.categories, 150);
  const s = await j('/api/search?q=distributed+systems');
  assert.ok(s.items.length >= 20 && s.total >= s.items.length);
  assert.ok(s.items.slice(0, 10).some((x) => /distributed|consensus|raft|paxos|cap|spanner|lamport/i.test(x.title)), 'search relevance');
  await j('/api/search', 400);
  const l = await j('/api/list?cat=distributed-systems&sort=hn&n=5'); assert.equal(l.items.length, 5);
  assert.ok(l.items[0].recs >= l.items[4].recs);
  await j('/api/list?type=bogus', 400); await j('/api/list?n=9999', 400); await j('/api/list?sort=bogus', 400);
  const f1 = await j('/api/feed?seed=7&n=12'), f2 = await j('/api/feed?seed=7&n=12'), f3 = await j('/api/feed?seed=8&n=12');
  assert.deepEqual(f1.items, f2.items); assert.notDeepEqual(f1.items, f3.items); assert.ok(f1.items.every((x) => x.reason));
  const liked = f1.items[0].vid, f4 = await j(`/api/feed?seed=7&like=${liked}&n=60`);
  assert.ok(!f4.items.some((x) => x.vid === liked)); assert.ok(f4.items.some((x) => x.reason === 'similar' || x.reason === 'hn'), 'likes steer feed');
  const v = await j('/api/video?vid=fNk_zzaMoSs'); assert.ok(v.mentions.length && v.mentions[0].stance === 'strong_rec');
  assert.equal(v.video.url, 'https://www.youtube.com/watch?v=fNk_zzaMoSs');
  const r = await j('/api/related?vid=fNk_zzaMoSs&n=20'); assert.equal(r.items.length, 20);
  assert.ok(r.items.every((x) => x.vid !== 'fNk_zzaMoSs') && new Set(r.items.map((x) => x.vid)).size === 20);
  await j('/api/video?vid=nope', 404); await j('/api/video?vid=', 404);
  const b = await j('/api/browse'); assert.equal(b.length, 16); assert.equal(b.flatMap((a) => a.categories).length, 150);
  const pls = await j('/api/playlists'); assert.equal(pls.length, 27);
  const p1 = await j('/api/playlist?slug=hn-canon'); assert.equal(p1.items.length, pl);
  assert.equal(pls.find((p) => p.slug === 'hn-canon').count, pl);
  await j('/api/playlist?slug=zzz', 404);
  assert.equal((await j('/api/videos?ids=fNk_zzaMoSs,xxxxxxxxxxx')).items.length, 1);
  for (const p of ['/', '/browse', '/browse?dur=xlong', '/search?q=x', '/a/software', '/c/cryptography', '/watch/fNk_zzaMoSs', '/playlists', '/p/hn-canon', '/liked', '/history', '/later', '/categories', '/settings', '/about', '/i18n.js']) {
    const [st] = await get(p); assert.equal(st, 200, p);
  }
  assert.equal((await get('/api/nope'))[0], 404);
  return stats;
}

await suite('no metadata', { YT_META_PATH: absent }, async (j, get) => {
  const st = await common(j, get, 0, 10);
  assert.equal(st.hasMeta, false);
  // unchanged behaviour: no YouTube fields, new filters ignored, new sorts invalid, old gem definition
  const l = await j('/api/list?n=60'), x = await j('/api/list?n=60&dur=xlong&date=year');
  assert.deepEqual(x, l); assert.ok(l.items.every((c) => !('dur' in c) && !('views' in c) && !('pub' in c)));
  for (const s of ['date', 'old', 'views', 'liked']) await j('/api/list?sort=' + s, 400);
  assert.ok(!('dur' in (await j('/api/video?vid=fNk_zzaMoSs')).video));
  const gems = V.filter((v) => v.score >= 5 && v.hn.recommenders <= 5 && v.hn.strong_recs >= 1 && v.shelf_life !== 'news').length;
  assert.equal(st.gems, gems); assert.equal((await j('/api/list?gems=1')).total, gems);
});

await suite('fixture metadata', { YT_META_PATH: fixture }, async (j, get) => {
  const st = await common(j, get, 3, canon.filter((v) => ![G1, G2, G3].includes(v)).length);
  assert.equal(st.hasMeta, true);
  const all = (q) => j('/api/list?n=60&' + q), ids = (r) => r.items.map((x) => x.vid);
  // gone / private hidden everywhere
  for (const g of [G1, G2, G3]) await j('/api/video?vid=' + g, 404);
  assert.equal((await j(`/api/videos?ids=${G1},${G2},${G3},${P[3]}`)).items.length, 1);
  assert.ok(!(await j(`/api/related?vid=${RH}&n=40`)).items.some((x) => x.vid === G2), 'related hides gone');
  assert.ok(!(await j('/api/playlist?slug=hn-canon')).items.some((x) => x.vid === G1));
  const title = (id) => V.find((v) => v.vid === id).title;
  for (const g of [G1, G2, G3]) assert.ok(!(await j('/api/search?n=60&q=' + encodeURIComponent(title(g)))).items.some((x) => x.vid === g), 'search hides gone');
  const seen = new Set(); for (let sd = 1; sd <= 5; sd++) for (const o of [0, 60, 120]) (await j(`/api/feed?seed=${sd}&offset=${o}&n=60`)).items.forEach((x) => seen.add(x.vid));
  assert.ok(![G1, G2, G3].some((g) => seen.has(g)), 'feed hides gone');
  assert.equal((await j('/api/list?n=1')).total, 6454 - 3);
  // fields: nulls kept, embeddable exposed
  const nul = (await j('/api/video?vid=' + P[2])).video; assert.equal(nul.views, null); assert.equal(nul.dur, null); assert.equal(nul.likes, null); assert.ok(nul.pub);
  const v3 = (await j('/api/video?vid=' + P[3])).video; assert.equal(v3.embeddable, false); assert.equal(v3.views, 500); assert.equal(v3.dur, 100); assert.equal(v3.likes, 50);
  assert.equal((await j('/api/video?vid=fNk_zzaMoSs')).video.embeddable, null); // row-less video: nulls
  const c = (await all('sort=views')).items[0]; assert.equal(c.views, 1e6); assert.equal(c.dur, 7200);
  // duration filters (null duration fails)
  same((await all('dur=short')).items, Pset(3, 12), 'short'); same((await all('dur=medium')).items, Pset(4, 8), 'medium');
  same((await all('dur=long')).items, Pset(5, 9, 10), 'long'); same((await all('dur=xlong')).items, Pset(6, 7, 11), 'xlong');
  // upload date filters (null date fails)
  same((await all('date=year')).items, Pset(7), 'year'); same((await all('date=2020s')).items, Pset(5, 7, 8, 11), '2020s');
  same((await all('date=2010s')).items, Pset(2, 4, 6, 10), '2010s'); same((await all('date=2000s')).items, Pset(3, 9, 12), '2000s');
  same((await all('dur=xlong&date=2020s')).items, Pset(7, 11), 'combined');
  same((await j('/api/search?n=60&dur=short&q=' + encodeURIComponent('a'))).items.filter((x) => !P.includes(x.vid)), new Set(), 'search honours dur');
  // sorts, null last
  const pubOrder = [7, 11, 5, 8, 2, 10, 4, 6, 9, 3, 12].map((i) => P[i]);
  let r = ids(await all('sort=date')); assert.deepEqual(r.slice(0, 11), pubOrder); assert.equal((await all('sort=date')).items[11].pub, null);
  r = ids(await all('sort=old')); assert.deepEqual(r.slice(0, 11), [...pubOrder].reverse()); assert.equal((await all('sort=old')).items[11].pub, null);
  r = await all('sort=views'); assert.deepEqual(ids(r).slice(0, 10), [6, 11, 9, 8, 4, 5, 7, 3, 12, 10].map((i) => P[i])); assert.equal(r.items[10].views, null);
  r = await all('sort=liked'); assert.deepEqual(ids(r).slice(0, 5), [5, 11, 9, 6, 4].map((i) => P[i]));
  assert.ok(r.items.slice(5).every((x) => x.views === null || x.views < 1000 || !P.slice(2).includes(x.vid) || x.vid === P[8]), 'low-view videos not ranked by ratio');
  assert.ok(!ids(r).slice(0, 5).includes(P[7]));
  assert.equal((await j('/api/search?n=5&sort=views&q=systems')).items.length, 5);
  // hidden gems: >=1 recommender, 1 <= views < 100k, not news
  const gem = new Set(V.filter((v) => P.includes(v.vid) && !v.shelf_life.startsWith('news') && v.hn.recommenders >= 1 && rows.find((r) => r.vid === v.vid)?.views != null && rows.find((r) => r.vid === v.vid).views < 1e5).map((v) => v.vid));
  assert.ok(gem.size > 0); same((await all('gems=1')).items, gem, 'gems'); assert.equal(st.gems, gem.size); assert.ok(!gem.has(P[9]));
  // validation
  for (const q of ['dur=bogus', 'date=bogus', 'sort=bogus', 'dur=short&date=x']) await j('/api/list?' + q, 400);
  await j('/api/list?dur=');
  await j('/api/search?q=x&dur=bogus', 400); await j('/api/search?q=x&date=bogus', 400);
  for (const s of ['date', 'old', 'views', 'liked']) await j('/api/list?sort=' + s);
});

// optional smoke against a real fetched file (not required)
if (fs.existsSync('data/youtube_meta.jsonl')) await suite('data/youtube_meta.jsonl', { YT_META_PATH: '' }, async (j) => {
  const st = await j('/api/stats'), real = fs.readFileSync('data/youtube_meta.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(st.hasMeta, real.length > 0);
  const gone = new Set(real.filter((r) => r.gone || r.privacy === 'private').map((r) => r.vid)), n = V.filter((v) => !gone.has(v.vid)).length;
  assert.equal(st.videos, n);
  const w = await j('/api/list?n=60&sort=views'); assert.ok(w.items.every((x) => !gone.has(x.vid)));
  const nums = w.items.map((x) => x.views).filter((x) => x !== null); assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  for (const d of ['short', 'medium', 'long', 'xlong']) await j('/api/list?dur=' + d);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL CHECKS PASSED');
