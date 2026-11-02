# HackerTube (local, English / 中文)

**English** | [简体中文](README.zh-CN.md)

An unofficial, self-hosted take on [HackerTube](https://hackertube.org) with a Chinese/English interface, built from its public data.

Based on [this post by Andrej Karpathy (@karpathy)](https://x.com/karpathy/status/2116957135661945283), which introduces HackerTube and invites people to point an AI agent at its data zip and ask for their own version. This project is not affiliated with or endorsed by him or hackertube.org.

## Run

Needs Node 26 and `unzip`. No npm dependencies, no build step.

```bash
node setup.mjs
node server.js
```

Then open http://127.0.0.1:8123 (`PORT=9000 node server.js` to change). Self-check: `node check.mjs`.

`setup.mjs` downloads about 18 MB from hackertube.org into `data/`. The data and playlists are not stored in this repo.

## Differences from hackertube.org

- UI language switch (English / 简体中文). Video titles, summaries, HN comments, tags and playlist text stay in English.
- Keyword search plus an embedding-centroid boost, instead of query embeddings.
- The player loads only after you press play.
- The frontend and backend are written from scratch.

## Optional YouTube metadata

Durations, view counts, likes and upload dates come from YouTube, so you fetch them yourself with your own free [YouTube Data API](https://developers.google.com/youtube/v3) key. Keep the key in an environment variable and never commit it.

1. `YOUTUBE_API_KEY=... node fetch_youtube_meta.mjs` writes `data/youtube_meta.jsonl` (resumable; re-run if it stops).
2. Restart `node server.js` (data is read at start).
3. Refresh later with `YOUTUBE_API_KEY=... node fetch_youtube_meta.mjs --refresh`.

With the file present: deleted and private videos are hidden; cards show duration, views and age; there is a Longs page (over 1 hour); duration and upload-date filters and sorts by upload date, views and like ratio are added; videos that forbid embedding link out to YouTube; "hidden gems" become videos recommended on HN by 1+ people with under 100k views, excluding news.

Without it, those features are absent and "hidden gems" means score >= 5 with <= 5 HN recommenders. `YT_META_PATH` overrides the file location. YouTube's terms don't allow redistributing this data, so don't publish that file.

## License and credits

- Code: [MIT](LICENSE).
- Data: [HackerTube](https://hackertube.org) and the [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) dataset, under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/). Comments remain the work of their authors. Video titles and channel names belong to their creators.
- Not affiliated with YouTube, Google, Hacker News or Y Combinator.
