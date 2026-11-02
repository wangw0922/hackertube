// Download the data this repo doesn't redistribute: the HackerTube data zip and the playlists. Usage: node setup.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SITE = 'https://hackertube.org';
const dir = new URL('data/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const get = async (p) => { const r = await fetch(SITE + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r; };

const zip = new URL('hackertube-data.zip', dir);
fs.writeFileSync(zip, Buffer.from(await (await get('/download/hackertube-data.zip')).arrayBuffer()));
execFileSync('unzip', ['-oq', zip.pathname, '-d', dir.pathname]);
fs.rmSync(zip);

// Keep only the curated text and video order: no YouTube metadata.
const list = await (await get('/api/playlists')).json();
const full = [];
for (const { slug } of list) {
  const p = await (await get(`/api/playlist?slug=${encodeURIComponent(slug)}`)).json();
  full.push({ slug, title: p.title, tier: p.tier, kind: p.kind, pitch: p.pitch, intro: p.intro, videos: p.videos.map(({ vid, note }) => ({ vid, note })) });
}
fs.writeFileSync(new URL('playlists-full.json', dir), JSON.stringify(full));
console.log(`ready: data/hackertube-data and ${full.length} playlists`);
