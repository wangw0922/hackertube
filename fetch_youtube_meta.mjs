// Fetch YouTube metadata into data/youtube_meta.jsonl. Resumable; rerun with --refresh to update everything.
// Usage: YOUTUBE_API_KEY=... node fetch_youtube_meta.mjs [--refresh]
import fs from 'node:fs';

const key = process.env.YOUTUBE_API_KEY;
if (!key) { console.error('YOUTUBE_API_KEY is not set'); process.exit(1); }
const dir = new URL('data/', import.meta.url);
const out = new URL('youtube_meta.jsonl', dir);
const lines = (u) => (fs.existsSync(u) ? fs.readFileSync(u, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

if (process.argv.includes('--refresh')) fs.rmSync(out, { force: true });
const done = new Set(lines(out).map((r) => r.vid));
const todo = lines(new URL('hackertube-data/videos.jsonl', dir)).map((v) => v.vid).filter((v) => !done.has(v));

const seconds = (d) => { // ISO 8601, e.g. PT1H2M3S or P1DT2H
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d ?? '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
};
const num = (s) => (s === undefined ? null : +s);

let gone = 0;
for (let i = 0; i < todo.length; i += 50) {
  const ids = todo.slice(i, i + 50);
  const q = new URLSearchParams({ part: 'snippet,contentDetails,statistics,status', id: ids.join(','), key });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${q}`);
  if (!r.ok) { // never print the URL: it holds the key
    const e = await r.json().catch(() => ({}));
    console.error(`stopped: HTTP ${r.status} ${e.error?.errors?.[0]?.reason ?? ''} ${e.error?.message ?? ''}; rerun to resume`);
    process.exit(1);
  }
  const got = new Map((await r.json()).items.map((it) => [it.id, it]));
  const rows = ids.map((vid) => {
    const it = got.get(vid);
    if (!it) { gone++; return { vid, gone: true }; } // deleted or private
    return { vid, published: it.snippet.publishedAt, duration_s: seconds(it.contentDetails.duration), views: num(it.statistics.viewCount),
      likes: num(it.statistics.likeCount), embeddable: it.status.embeddable, privacy: it.status.privacyStatus };
  });
  fs.appendFileSync(out, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${Math.min(i + 50, todo.length)}/${todo.length}`);
  await new Promise((f) => setTimeout(f, 200));
}
console.log(`done: ${todo.length} fetched, ${gone} deleted or private`);
