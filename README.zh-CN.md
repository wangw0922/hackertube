# HackerTube（本地版，English / 中文）

[English](README.md) | **简体中文**

这是 [HackerTube](https://hackertube.org) 的非官方自托管版本，基于其公开数据构建，界面支持中英文切换。

本项目基于 [Andrej Karpathy (@karpathy) 的这篇帖子](https://x.com/karpathy/status/2116957135661945283)制作。原帖介绍了 HackerTube，并鼓励大家让 AI 代理读取它的数据包，做自己的版本。本项目与作者及 hackertube.org 无关联，也未获其背书。

## 运行

需要 Node 26 和 `unzip`。没有 npm 依赖，也不需要构建。

```bash
node setup.mjs
node server.js
```

然后打开 http://127.0.0.1:8123（可用 `PORT=9000 node server.js` 换端口）。自检命令：`node check.mjs`。

`setup.mjs` 会从 hackertube.org 下载约 18 MB 的数据到 `data/`。数据和播放列表不存放在本仓库中。

## 与 hackertube.org 的差异

- 界面可切换语言（English / 简体中文）。视频标题、简介、HN 评论、标签和播放列表文字保持英文。
- 搜索使用关键词匹配，并用向量相近的视频扩展结果，不对查询语句做向量化。
- 点击播放后才加载播放器。
- 前端和后端均为重新编写。

## 可选：YouTube 元数据

时长、播放量、点赞数和上传日期来自 YouTube，需要用你自己的免费 [YouTube Data API](https://developers.google.com/youtube/v3) 密钥拉取。请把密钥放在环境变量里，不要提交到仓库。

1. 运行 `YOUTUBE_API_KEY=... node fetch_youtube_meta.mjs`，结果写入 `data/youtube_meta.jsonl`（中断后重新运行会接着拉取）。
2. 重启 `node server.js`（数据在启动时读取）。
3. 以后用 `YOUTUBE_API_KEY=... node fetch_youtube_meta.mjs --refresh` 刷新。

有这个文件时：隐藏已删除和私有的视频；卡片显示时长、播放量和上传时间；增加 Longs 页（超过 1 小时）；增加时长和上传日期筛选，以及按上传日期、播放量和点赞率排序；禁止嵌入的视频改为跳转 YouTube；“冷门佳作”变为至少有 1 位 HN 用户推荐、播放量低于 10 万且不是新闻的视频。

没有这个文件时，上述功能不会出现，“冷门佳作”指得分不低于 5 且推荐者不超过 5 人的视频。可用 `YT_META_PATH` 指定文件位置。YouTube 条款不允许再分发这些数据，请不要公开该文件。

## 许可与致谢

- 代码：[MIT](LICENSE)。
- 数据：来自 [HackerTube](https://hackertube.org) 和 [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) 数据集，采用 [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/) 许可。评论版权归原作者所有，视频标题和频道名称归其创作者所有。
- 与 YouTube、Google、Hacker News 及 Y Combinator 均无关联。
