// Local HackerTube replica backend: node:http, zero deps, everything in memory.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const t0 = performance.now();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'data', 'hackertube-data') + '/';
const jsonl = (f) => fs.readFileSync(D + f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---------- load ----------
// Optional YouTube metadata (fetch_youtube_meta.mjs). Absent file: everything behaves as without it. YT_META_PATH overrides (tests).
const META = process.env.YT_META_PATH || path.join(ROOT, 'data', 'youtube_meta.jsonl');
const meta = new Map(); // vid -> row, later rows win
if (fs.existsSync(META)) for (const l of fs.readFileSync(META, 'utf8').split('\n')) { try { const r = JSON.parse(l); meta.set(r.vid, r); } catch {} } // skips blank/truncated lines
const hasMeta = meta.size > 0;
const videos = jsonl('videos.jsonl').filter((v) => { const m = meta.get(v.vid); return !(m && (m.gone === true || m.privacy === 'private')); }); // gone videos vanish at load, so every endpoint hides them
const byId = new Map(videos.map((v) => [v.vid, v]));
const taxonomy = JSON.parse(fs.readFileSync(D + 'taxonomy.json', 'utf8'));
const catInfo = new Map(); // id -> {id,name,description,area}
for (const a of taxonomy.areas) for (const c of a.categories) catInfo.set(c.id, { ...c, area: a.id });
const ZH = new Function(fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8') + ';return ZH_TAX')(); // zh names also searchable

const mentions = new Map(); // vid -> [mention]
let mentionCount = 0;
for (const m of jsonl('mentions.jsonl')) {
  mentionCount++;
  const a = mentions.get(m.vid) ?? mentions.set(m.vid, []).get(m.vid);
  a.push({ id: m.hn_comment_id, url: m.hn_url, author: m.author, month: m.month, stance: m.stance, why: m.why, text: m.text });
}
const STANCE_ORDER = { strong_rec: 0, rec: 1, reference: 2, joke: 3, critical: 4 };
for (const a of mentions.values()) a.sort((x, y) => STANCE_ORDER[x.stance] - STANCE_ORDER[y.stance] || (x.month < y.month ? 1 : -1));

const related = new Map(jsonl('related.jsonl').map((r) => [r.vid, r.related.filter((x) => byId.has(x.vid))]));
const playlists = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'playlists-full.json'), 'utf8'));
for (const p of playlists) p.videos = p.videos.filter((x) => byId.has(x.vid));

// embeddings: .npy = magic(6) ver(2) uint16-LE header length (bytes 8-9) header data. Slice into a fresh buffer
// so the Float16Array is 2-byte aligned (a Buffer from readFileSync may sit at an odd pool offset).
const npy = fs.readFileSync(D + 'embeddings.npy');
const hdr = npy.readUInt16LE(8);
const raw = npy.buffer.slice(npy.byteOffset + 10 + hdr, npy.byteOffset + npy.byteLength);
const E16 = new Float16Array(raw);
const DIM = 384;
const EMB = Float32Array.from(E16); // widen once: faster dot products
const ids = JSON.parse(fs.readFileSync(D + 'embedding_ids.json', 'utf8'));
const row = new Map(ids.map((v, i) => [v, i]));
if (EMB.length !== ids.length * DIM) throw new Error('embedding shape mismatch');

// ---------- derived per-video data ----------
const maxYear = Math.max(...videos.map((v) => v.hn.last_year));
const fin = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const X = new Map(videos.map((v) => { // vid -> nullable YouTube numbers
  const m = meta.get(v.vid), views = fin(m?.views), likes = fin(m?.likes), pub = m?.published ? Date.parse(m.published) : NaN;
  return [v.vid, { dur: fin(m?.duration_s), views, likes, pub: fin(pub), emb: m?.embeddable ?? null, ratio: views >= 1000 && likes !== null ? likes / views : null }];
}));
const isGem = hasMeta ? (v) => v.hn.recommenders >= 1 && X.get(v.vid).views !== null && X.get(v.vid).views < 1e5 && v.shelf_life !== 'news'
  : (v) => v.score >= 5 && v.hn.recommenders <= 5 && v.hn.strong_recs >= 1 && v.shelf_life !== 'news';
const catIdsOf = (v) => v.categories.map((c) => c.id);
const lc = (s) => String(s ?? '').toLowerCase();
for (const v of videos) {
  const cs = v.categories.map((c) => catInfo.get(c.id)).filter(Boolean);
  v._lastRec = (mentions.get(v.vid) ?? []).filter((m) => m.stance === 'rec' || m.stance === 'strong_rec').reduce((a, m) => (m.month > a ? m.month : a), '');
  v._f = [ // [text, weight]: search fields
    [lc(v.title), 6], [lc(v.channel), 4], [lc(v.tags.join(' ')), 4], [lc(v.primary_topic), 4],
    [lc(cs.map((c) => c.name + ' ' + (ZH[c.id] ?? '') + ' ' + v.categories.find((x) => x.id === c.id).area_name + ' ' + (ZH[c.area] ?? '')).join(' ')), 3],
    [lc(cs.map((c) => c.description).join(' ')), 1.5], [lc(v.summary), 2], [lc(v.why_hn), 1.5],
  ];
}
const ycard = (v) => { const x = X.get(v.vid); return { dur: x.dur, views: x.views, pub: x.pub }; };
const card = (v, reason) => ({
  vid: v.vid, title: v.title, channel: v.channel, type: v.content_type,
  recs: v.hn.recommenders, first: v.hn.first_year, last: v.hn.last_year, ...(reason && { reason }), ...(hasMeta && ycard(v)),
});

// ---------- embeddings: similarity ----------
function centroid(vids) {
  const c = new Float32Array(DIM);
  for (const id of vids) { const r = row.get(id); if (r !== undefined) for (let j = 0; j < DIM; j++) c[j] += EMB[r * DIM + j]; }
  const n = Math.hypot(...c) || 1;
  return c.map((x) => x / n);
}
function sims(q) { // dot product of q with every row
  const out = new Float32Array(ids.length);
  for (let i = 0, o = 0; i < ids.length; i++, o += DIM) { let s = 0; for (let j = 0; j < DIM; j++) s += EMB[o + j] * q[j]; out[i] = s; }
  return out;
}
function similar(vid, n) {
  const r = row.get(vid);
  if (r === undefined) return [];
  const s = sims(EMB.subarray(r * DIM, r * DIM + DIM));
  return [...s.keys()].filter((i) => i !== r && byId.has(ids[i])).sort((a, b) => s[b] - s[a]).slice(0, n).map((i) => ids[i]);
}

// ---------- param validation ----------
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const int = (q, k, def, min, max) => {
  const s = q.get(k); if (s === null || s === '') return def;
  if (!/^\d{1,10}$/.test(s) || +s < min || +s > max) throw bad(`bad ${k}`);
  return +s;
};
const oneOf = (q, k, set) => { const s = q.get(k); if (!s) return ''; if (!set.has(s)) throw bad(`bad ${k}`); return s; };
const vidList = (q, k, max = 300) => {
  const s = q.get(k); if (!s) return [];
  const a = s.split(',').slice(0, max);
  if (!a.every((x) => /^[\w-]{11}$/.test(x))) throw bad(`bad ${k}`);
  return a;
};
const vidParam = (q) => { const v = byId.get(q.get('vid') ?? ''); if (!v) throw Object.assign(new Error('no such video'), { status: 404 }); return v; };
const TYPES = new Set(videos.map((v) => v.content_type)), LEVELS = new Set(videos.map((v) => v.level));
const AREAS = new Set(taxonomy.areas.map((a) => a.id)), SORTS = new Set(['relevance', 'hn', 'recent', ...(hasMeta ? ['date', 'old', 'views', 'liked'] : [])]);
const DURS = { short: [0, 240], medium: [240, 1200], long: [1200, 3601], xlong: [3601, Infinity] }; // [min, max) seconds
const decade = (a) => (ms) => { const y = new Date(ms).getUTCFullYear(); return y >= a && y < a + 10; };
const DATES = { year: (ms) => ms >= Date.now() - 365 * 864e5, '2020s': decade(2020), '2010s': decade(2010), '2000s': decade(2000) };

function filters(q) {
  const f = { type: oneOf(q, 'type', TYPES), level: oneOf(q, 'level', LEVELS), cat: oneOf(q, 'cat', catInfo), area: oneOf(q, 'area', AREAS),
    evergreen: q.get('evergreen') === '1', gems: q.get('gems') === '1', sort: oneOf(q, 'sort', SORTS) || 'relevance',
    dur: hasMeta ? oneOf(q, 'dur', new Set(Object.keys(DURS))) : '', date: hasMeta ? oneOf(q, 'date', new Set(Object.keys(DATES))) : '' }; // without metadata both are ignored, as before
  const [lo, hi] = DURS[f.dur] ?? [];
  return { sort: f.sort, ok: (v) => (!f.type || v.content_type === f.type) && (!f.level || v.level === f.level)
    && (!f.cat || v.categories.some((c) => c.id === f.cat)) && (!f.area || v.categories.some((c) => c.area === f.area))
    && (!f.evergreen || v.shelf_life === 'evergreen') && (!f.gems || isGem(v))
    && (!f.dur || (X.get(v.vid).dur !== null && X.get(v.vid).dur >= lo && X.get(v.vid).dur < hi))
    && (!f.date || (X.get(v.vid).pub !== null && DATES[f.date](X.get(v.vid).pub))) };
}
function page(q, arr, mk = card) {
  const offset = int(q, 'offset', 0, 0, 1e6), n = int(q, 'n', 36, 1, 60);
  return { total: arr.length, items: arr.slice(offset, offset + n).map((x) => mk(x)), more: offset + n < arr.length };
}
const nl = (k, dir) => (a, b) => { // numeric YouTube sort, null last; ties by score
  const x = X.get(a.vid)[k], y = X.get(b.vid)[k];
  return x === null || y === null ? (x === null) - (y === null) || b.score - a.score : dir * (y - x) || b.score - a.score;
};
const bySort = (sort) => sort === 'date' ? nl('pub', 1) : sort === 'old' ? nl('pub', -1) : sort === 'views' ? nl('views', 1) : sort === 'liked' ? nl('ratio', 1)
  : sort === 'hn' ? (a, b) => b.hn.recommenders - a.hn.recommenders || b.score - a.score
  : sort === 'recent' ? (a, b) => (a._lastRec < b._lastRec ? 1 : a._lastRec > b._lastRec ? -1 : b.score - a.score)
  : (a, b) => b.score - a.score || b.hn.recommenders - a.hn.recommenders;

// ---------- feed: score-weighted random sampling ----------
function hash01(s) { // deterministic uniform (0,1) from a string
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return ((h >>> 0) + 0.5) / 4294967296;
}
function feed(q) {
  const like = vidList(q, 'like'), dislike = vidList(q, 'dislike'), seen = vidList(q, 'seen');
  const seed = int(q, 'seed', 0, 0, 2 ** 31), showNews = q.get('news') === '1';
  const skip = new Set([...like, ...dislike, ...seen]);
  const explored = new Set([...like, ...seen].flatMap((id) => byId.has(id) ? catIdsOf(byId.get(id)) : []));
  const lk = like.slice(-20);
  const sim = lk.length ? sims(centroid(lk)) : null;
  const hn = new Map(); // vid -> summed shared recommenders with liked videos
  for (const id of lk) for (const r of related.get(id) ?? []) hn.set(r.vid, (hn.get(r.vid) ?? 0) + r.shared_recommenders);
  const scored = [];
  for (const v of videos) {
    if (skip.has(v.vid) || (!showNews && v.shelf_life === 'news')) continue;
    const opts = [['random', 1.5]]; // [reason, weight]
    if (v.score >= 8) opts.push(['classic', v.score]);
    if (isGem(v)) opts.push(['gem', v.score * 1.5]);
    if (v.hn.last_year >= maxYear - 1 && v.hn.recommenders >= 2) opts.push(['recent', v.score + 2]);
    if (v.score >= 3 && !explored.has(v.categories[0]?.id)) opts.push(['unexplored', v.score]);
    if (sim && sim[row.get(v.vid)] > 0.6) opts.push(['similar', 80 * (sim[row.get(v.vid)] - 0.55)]);
    if (hn.has(v.vid)) opts.push(['hn', 3 + 4 * hn.get(v.vid)]);
    let best = null, bk = -Infinity;
    for (const [r, w] of opts) { const k = Math.log(hash01(`${seed}|${v.vid}|${r}`)) / w; if (k > bk) { bk = k; best = r; } } // Efraimidis-Spirakis
    scored.push([bk, v, best]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const offset = int(q, 'offset', 0, 0, 1e6), n = int(q, 'n', 36, 1, 60);
  return { items: scored.slice(offset, offset + n).map(([, v, r]) => card(v, r)), more: offset + n < scored.length };
}

// ---------- search ----------
// ponytail: keyword scoring only; no query embedding, so a query with no word in common with a video can't reach
// it except via the top-hit centroid below. Upgrade path: embed the query with fastembed bge-small and rank by dot.
function search(q) {
  const all = [...new Set(lc(q.get('q')).trim().split(/[^\p{L}\p{N}+#.]+/u).filter(Boolean))].slice(0, 8);
  const STOP = new Set('a an the of and or to in on for with how what why is are was be do does it at by'.split(' '));
  const toks = all.filter((x) => !STOP.has(x)).length ? all.filter((x) => !STOP.has(x)) : all;
  if (!toks.length) throw bad('missing q');
  const { ok, sort } = filters(q);
  const per = videos.map((v) => toks.map((t) => v._f.reduce((s, [txt, w]) => s + (txt.includes(t) ? w : 0), 0)));
  const idf = toks.map((_, i) => Math.log(1 + videos.length / (per.filter((p) => p[i] > 0).length + 1)));
  const phrase = toks.length > 1 ? lc(q.get('q')).trim() : '';
  let kw = videos.map((v, i) => {
    const hit = per[i].filter((x) => x > 0).length;
    return hit ? per[i].reduce((s, x, j) => s + x * idf[j], 0) * (hit / toks.length) ** 2 + (phrase && v._f[0][0].includes(phrase) ? 20 : 0) : 0;
  });
  const top = [...kw.keys()].filter((i) => kw[i] > 0).sort((a, b) => kw[b] - kw[a]).slice(0, 5); // centroid boost: topic neighbours of top hits
  if (top.length) { const s = sims(centroid(top.map((i) => videos[i].vid))); kw = kw.map((k, i) => k + 60 * Math.max(0, s[row.get(videos[i].vid)] - 0.7)); }
  const hits = videos.map((v, i) => [v, kw[i] + v.score * 0.01]).filter(([v, k]) => k > 0.1 && ok(v));
  hits.sort(sort === 'relevance' ? (a, b) => b[1] - a[1] : (a, b) => bySort(sort)(a[0], b[0]));
  return page(q, hits.map((h) => h[0]));
}

// ---------- endpoints ----------
const api = {
  stats: () => ({ videos: videos.length, comments: mentionCount, categories: catInfo.size, areas: taxonomy.areas.length, playlists: playlists.length,
    fromYear: Math.min(...videos.map((v) => v.hn.first_year)), toYear: maxYear, gems: videos.filter(isGem).length, hasMeta }),
  feed,
  video(q) {
    const v = vidParam(q);
    const x = X.get(v.vid);
    return { video: { ...v, _f: undefined, _lastRec: undefined, gem: isGem(v), ...(hasMeta && { ...ycard(v), likes: x.likes, embeddable: x.emb }) }, mentions: mentions.get(v.vid) ?? [] };
  },
  related(q) {
    const v = vidParam(q), n = int(q, 'n', 20, 1, 40);
    // shared_recommenders==1 is mostly noise (one commenter's links), so only >=2 counts as "first"; similar fills the rest
    const out = (related.get(v.vid) ?? []).filter((r) => r.shared_recommenders >= 2).slice(0, n).map((r) => ({ ...card(byId.get(r.vid)), via: 'hn' }));
    const have = new Set([v.vid, ...out.map((x) => x.vid)]);
    for (const id of similar(v.vid, n + out.length)) if (out.length < n && !have.has(id)) out.push({ ...card(byId.get(id)), via: 'similar' });
    return { items: out };
  },
  list(q) {
    const { ok, sort } = filters(q);
    return page(q, videos.filter(ok).sort(bySort(sort)));
  },
  search,
  videos: (q) => ({ items: vidList(q, 'ids', 300).filter((id) => byId.has(id)).map((id) => card(byId.get(id))) }),
  browse() {
    return taxonomy.areas.map((a) => {
      const cats = a.categories.map((c) => ({ id: c.id, name: c.name, count: videos.filter((v) => v.categories.some((x) => x.id === c.id)).length }));
      return { id: a.id, name: a.name, count: videos.filter((v) => v.categories.some((x) => x.area === a.id)).length, categories: cats };
    });
  },
  playlists: () => playlists.map((p) => ({ slug: p.slug, title: p.title, pitch: p.pitch, kind: p.kind, tier: p.tier, count: p.videos.length, cover: p.videos.slice(0, 4).map((x) => x.vid) })),
  playlist(q) {
    const p = playlists.find((x) => x.slug === q.get('slug'));
    if (!p) throw Object.assign(new Error('no such playlist'), { status: 404 });
    return { slug: p.slug, title: p.title, pitch: p.pitch, intro: p.intro, kind: p.kind, tier: p.tier, items: p.videos.map((x) => ({ ...card(byId.get(x.vid)), note: x.note })) };
  },
};

// ---------- http ----------
const STATIC = { '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'] };
const indexHtml = () => fs.readFileSync(path.join(ROOT, 'index.html')); // re-read per request: edit and refresh
const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); };

http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'application/json', '{"error":"method not allowed"}');
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5);
      if (!Object.hasOwn(api, name)) return send(res, 404, 'application/json', '{"error":"not found"}');
      try { return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(api[name](u.searchParams))); }
      catch (e) { return send(res, e.status ?? 500, 'application/json', JSON.stringify({ error: e.status ? e.message : 'server error' })); }
    }
    if (u.pathname === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
    const s = STATIC[u.pathname];
    if (s) return send(res, 200, s[1], fs.readFileSync(path.join(ROOT, s[0])));
    send(res, 200, 'text/html; charset=utf-8', indexHtml()); // every other path: SPA shell
  } catch (e) { console.error(e); send(res, 500, 'application/json', '{"error":"server error"}'); }
}).listen(+process.env.PORT || 8123, '127.0.0.1', function () {
  console.log(`ready in ${Math.round(performance.now() - t0)} ms (${videos.length} videos, ${mentionCount} comments) http://127.0.0.1:${this.address().port}`);
});
