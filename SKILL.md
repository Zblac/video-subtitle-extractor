---
name: video-subtitle-extractor
description: 给一个视频链接（YouTube / Bilibili / 抖音 / 大多数 yt-dlp 支持的站点），自动拿到可读的字幕：优先平台自带字幕，没有就用本地 faster-whisper 转录，输出 srt / vtt / txt / json。也支持传入本地音视频文件直接转录。适用于"把这个视频的字幕/逐字稿/内容提取出来""根据视频内容回答问题""总结视频要点"等任务。
compatibility: 需要 Node.js 18+、Python 3.9+；GPU（CUDA）可选但强烈推荐，ffmpeg 可选（抖音音轨合并时需要）。
---

# video-subtitle-extractor

把「视频链接 → 字幕文本」这件事固化成一个可调用的命令行工具。字幕是后续一切问答、总结、翻译、切片的输入。

## 何时用

- 用户给出视频链接（youtube.com / youtu.be / bilibili.com / b23.tv / douyin.com / v.douyin.com / 其他 yt-dlp 支持的站点），要字幕、逐字稿、要点、内容问答。
- 用户给出本地视频/音频文件，要转文字。
- 已经在别处拿到了媒体直链（例如抖音网页里音画分离的两条地址），需要下载并转录。

不适用：纯音频转写服务（有专用 ASR 工具时优先用那个）；需要说话人分离、时间轴逐字对齐到词级字幕的精细字幕工程。

## 安装（首次，Agent 自己执行，不要问用户）

先体检，缺什么补什么：

```bash
python <skill-dir>/scripts/install.py --doctor
```

没装或自检不绿，就拉起完整安装（会下载代码、装 Python 依赖、预下载 Whisper small 模型，约 1~2 分钟 + 模型 500MB 左右）：

```powershell
# Windows
irm https://raw.githubusercontent.com/Zblac/video-subtitle-extractor/main/scripts/bootstrap.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Zblac/video-subtitle-extractor/main/scripts/bootstrap.sh | bash
```

自定义安装位置与模型：

```powershell
$env:VSX_DEST="C:\path\to\skills\video-subtitle-extractor"; $env:VSX_MODEL="medium"; irm ... | iex
```

- 默认装到 `~/.doubao/skills/video-subtitle-extractor`（可用 `VSX_DEST` 覆盖）。
- 模型、输出、缓存都在 `VSX_HOME`（默认 `~/.video-subtitle-extractor`），升级技能不会重下模型。
- 只有 CPU 的机器加 `--skip-gpu` 给 install.py，或 `VSX_MODEL=base` 换小模型。

## 用法（一条命令）

```bash
node <skill-dir>/ytsub.js "<视频链接>" --json
```

机器可读输出：stdout 最后一行是完整 JSON（过程日志走 stderr），关键字段：

```json
{
  "id": "BV1xx...",
  "title": "...",
  "final": { "source": "official|whisper", "count": 121, "duration": 1128,
             "dir": ".../out/BV1xx", "files": { "txt": "...", "srt": "...", "vtt": "...", "json": "..." } },
  "stages": { "download": {...}, "api": {...}, "asr": {...} },
  "timings": { "download": 5.2, "asr": 19.1, "total": 25.4 },
  "warnings": []
}
```

拿到 `final.files.txt` 就是后续问答的依据；`final.source == "whisper"` 说明是本地转录（可能有同音错字），回答要点时按语义理解、不要机械照抄专名。

常用参数：

| 参数 | 作用 |
|---|---|
| `--json` | stdout 只输出结构化结果，Agent 必用 |
| `--model small\|base\|medium\|large-v3` | 转录模型，默认 small；中文长视频建议 medium |
| `--device auto\|cuda\|cpu` | 默认 auto（GPU 优先，失败退 CPU） |
| `--out <dir>` | 输出根目录，默认 `~/.video-subtitle-extractor/out` |
| `--proxy <url>` | yt-dlp 代理（YouTube 用，国内站点默认不走） |
| `--no-api` | 不调第三方字幕 API，强制走本地转录 |
| `--no-download` | 不下载，复用目录里已有 `media.*` |
| `--cookies chrome` | yt-dlp 从浏览器取 cookie（需要登录态的平台） |
| `--media <file>` | 直接对本地音视频转录（配合下面的抖音流程） |
| `--print-text` | 把字幕正文打到 stdout（适合小视频直接读） |

## 平台差异（照这个走，不要瞎试）

**YouTube** — 有官方/自动字幕时 1 秒出结果（需要 `.env` 里的 `YOUTUBE_TRANSCRIPT_API_TOKEN`，没有就走下载 + 转录，30 秒级）。国内网络访问 YouTube 必须给 `--proxy`。

**Bilibili / b23.tv** — yt-dlp 下载后本地转录，170 秒视频热跑约 20 秒。平台自带字幕接口要登录 cookie，没 cookie 就跳过，属正常。

**抖音** — 官方解析接口经常以"内容提供方设置"拒答，yt-dlp 又要新鲜 cookie。可靠路径是浏览器 + 直链：

1. 用浏览器工具打开视频页（`v.douyin.com` 短链会跳到 `www.douyin.com/video/<id>`）。
2. 从页面里取出两条直链：`media-video...`（画面）和 `media-audio...`（音轨），写到文件或直接传参。
3. 下载并合成：

```bash
python <skill-dir>/python/media.py --dir "<out>/douyin-<id>" --video-url "<视频直链>" --audio-url "<音频直链>"
```

4. 转录（复用同一条链路）：

```bash
node <skill-dir>/ytsub.js --media "<out>/douyin-<id>/media.mp4" --json
```

拿不到直链时的降级：先读页面正文，抖音网页版自己会给出「章节要点」（分章节的 AI 摘要），可作为骨架，但要向用户说明这是平台摘要而非逐字稿。

**其他站点** — 直接跑主命令，yt-dlp 能下就能转。

## 成本与预期（别让用户等得莫名其妙）

- 平台有字幕：1~3 秒。
- 本地转录：GPU（如 RTX 3060 + small）约等于音频时长的 1/8~1/10；纯 CPU 约 1/2~1/1，长视频务必提醒或用 `base`。
- 每次冷启动约 2 秒加载模型；设备选择会缓存在 `~/.video-subtitle-extractor/cache/device.json`。

## 故障排查

| 现象 | 处理 |
|---|---|
| `未找到 node` / Node < 18 | 装 Node 18+，或告诉用户需要它 |
| `下载失败：Fresh cookies ... needed` | 该站要新鲜 cookie：`--cookies chrome`（Chrome 在运行会锁 cookie 库，需先关掉）或按抖音的浏览器直链流程 |
| `av ... IndexError` | 媒体文件没有音频轨（音画分离站点常见），用 `python/media.py` 合并后再转录 |
| 转录很慢 | 检查是否退回 CPU：`report.json` 里 `stages.asr.device`；确认 CUDA 库装好（`--install-deps` 会带 nvidia wheel） |
| 中文输出是繁体 | 已内置 zhconv 转简；若仍是繁体，确认依赖装了 |
| 模型下载卡住 | 设 `VSX_HF_ENDPOINT=https://hf-mirror.com`（默认已是）或 `HTTPS_PROXY` 后重跑 `--model` |

## 交付约定（Agent 侧）

- 用户只要"要点/总结/问答"：把 `subtitles.txt` 读进来自己消化后回答，不要把几万字逐字稿糊在对话里；需要时把 txt/srt 作为附件交付。
- 用户要"字幕文件"：交付 `subtitles.srt` + `subtitles.txt`（+ 需要时 `subtitles.vtt`）。
- 引用具体句子/时间点时，用 `subtitles.json` 或 srt 里的时间轴，不要自己编时间。
- 本地转录可能有同音错字，涉及品牌、人名、型号（昇腾/盘古/端到端 这类）先按上下文校正再引用。
- 不要把 `.env` 里的任何 token 写进回复、日志或交付文件。
