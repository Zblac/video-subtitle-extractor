# video-subtitle-extractor

给一个视频链接，拿到它的字幕。优先用平台自带字幕，没有就用本地 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 转录；输出 `srt / vtt / txt / json` 四种格式，同时留一份 `report.json` 记录每个阶段的耗时与失败原因。

它同时是一个 **可移植的 Agent Skill**：技能目录里有 `SKILL.md`，其他用户的 Agent 读完就能自己装、自己跑，不需要人工配置。

## 它解决什么问题

- YouTube / Bilibili / 抖音 / 大多数 yt-dlp 支持的站点，一条命令拿到逐字稿。
- 平台字幕要登录、要 cookie、接口拒答时，自动退到本地转录，不会卡死在一步。
- 转录在本地跑，音频不上传第三方，隐私可控；有 GPU 时 170 秒视频约 20 秒出结果。
- 输出是结构化 JSON，Agent 可以直接读文件路径、句数、耗时、来源（官方字幕 or 转录）。

## 环境要求

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| Node.js ≥ 18 | 必需 | 主流程在 Node 里跑（分段、格式写出） |
| Python ≥ 3.9 | 必需 | 转录与安装器 |
| ffmpeg | 可选 | 抖音这类音画分离的站点合并音轨时需要 |
| NVIDIA GPU + CUDA | 可选 | 有则快 5~10 倍；没有自动退 CPU |

## 安装

### 一条命令（推荐）

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Zblac/video-subtitle-extractor/main/scripts/bootstrap.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Zblac/video-subtitle-extractor/main/scripts/bootstrap.sh | bash
```

装到 `~/.doubao/skills/video-subtitle-extractor`，同时装依赖并预下载 `small` 模型（约 500MB）。

可覆盖的环境变量：`VSX_DEST`（安装目录）、`VSX_MODEL`（`base`/`small`/`medium`/`large-v3`/`none`）、`VSX_REPO`、`VSX_REF`、`VSX_PYTHON`。

### 手动

```bash
git clone https://github.com/Zblac/video-subtitle-extractor.git
cd video-subtitle-extractor
python scripts/install.py --install-deps --model small
python scripts/install.py --doctor      # 体检，输出 JSON
```

纯 CPU 机器：`python scripts/install.py --install-deps --skip-gpu --model base`。

## 用法

```bash
node ytsub.js "https://www.bilibili.com/video/BV1xxxxxxxx" --json
```

stdout 最后一行是 JSON：

```json
{
  "id": "BV1xxxxxxxx",
  "title": "视频标题",
  "final": {
    "source": "whisper",
    "count": 121,
    "duration": 1128,
    "dir": "~/.video-subtitle-extractor/out/BV1xxxxxxxx",
    "files": { "txt": "...", "srt": "...", "vtt": "...", "json": "..." }
  },
  "timings": { "download": 5.2, "asr": 19.1, "total": 25.4 },
  "warnings": []
}
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--json` | 结构化输出（Agent 用） |
| `--model` | `base`/`small`/`medium`/`large-v3`，默认 `small` |
| `--device` | `auto`（默认）/ `cuda` / `cpu` |
| `--out` | 输出根目录，默认 `~/.video-subtitle-extractor/out` |
| `--proxy` | YouTube 下载代理 |
| `--no-api` | 不调第三方字幕 API |
| `--no-download` | 复用已下载的媒体 |
| `--cookies chrome` | 从浏览器读 cookie（需要登录态的平台） |
| `--media <file>` | 直接对本地音视频转录 |
| `--print-text` | 字幕正文打到 stdout |

## 各平台怎么走

- **YouTube**：配置 `.env` 里的 `YOUTUBE_TRANSCRIPT_API_TOKEN` 后，有官方字幕时约 1 秒返回；没配也能用，走下载 + 转录。国内网络需 `--proxy`。
- **Bilibili / b23.tv**：yt-dlp 下载后本地转录。平台字幕接口要登录态 cookie，没 cookie 直接跳过。
- **抖音**：官方解析接口常以"内容提供方设置"拒答，yt-dlp 又要新鲜 cookie。可靠路径是浏览器拿直链后本地下载：

```bash
python python/media.py --dir out/douyin-<id> --video-url "<media-video 直链>" --audio-url "<media-audio 直链>"
node ytsub.js --media out/douyin-<id>/media.mp4 --json
```

## 输出目录

```
~/.video-subtitle-extractor/
├── models/                  # faster-whisper 模型（升级技能不重下）
├── cache/device.json        # 上次成功的设备组合，跳过 CUDA 试错
└── out/<video-id>/
    ├── media.mp4
    ├── api.*                # 平台/API 字幕（如果拿到）
    ├── asr_raw.json         # 原始转录
    ├── subtitles.{srt,vtt,txt,json}
    └── report.json
```

## 性能参考（RTX 3060 + small，Ryzen 7 3700X）

| 场景 | 耗时 |
|---|---|
| YouTube 有官方字幕 | ~1s |
| 170s 视频，无字幕（冷启） | ~25s（下载 5s + 模型 2s + 推理 17s） |
| 170s 视频，无字幕（热） | ~19s |
| 18m48s 视频 | ~111s（下载 + 推理 101s） |

## 作为 Agent Skill 安装

`SKILL.md` 是给 Agent 的说明书，包含安装、用法、平台差异、排错与交付约定。把整个目录放进技能根目录即可被识别：

```
<skills-root>/video-subtitle-extractor/
├── SKILL.md
├── ytsub.js
├── lib/
├── python/
└── scripts/
```

## 发布（维护者）

```powershell
$env:GITHUB_TOKEN="ghp_xxx"
python scripts/publish.py --private
```

会创建仓库、替换占位符、推送、打 `v1.0.0` tag 并上传 release zip。

## 许可

MIT。转录模型（faster-whisper / Whisper）遵循其各自许可证。
