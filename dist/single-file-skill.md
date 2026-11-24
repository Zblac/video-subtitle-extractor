---
name: video-subtitle-extractor
description: 单文件技能。用户给出任意视频链接（YouTube / Bilibili / 抖音 / 大多数 yt-dlp 支持的站点）或本地音视频文件，按本文件步骤操作即可自动完成：安装工具 → 下载视频 → 取平台字幕或本地 Whisper 转录 → 产出 srt/vtt/txt/json → 基于逐字稿回答用户问题。
version: 1.0.0
repo: https://github.com/Zblac/video-subtitle-extractor
license: MIT
---

# 视频字幕提取 Skill（单文件版）

你（Agent）读到这个文件，就等于拿到了全套能力。**不要向用户索要脚本、不要手写转录代码、不要让用户自己装环境**——按下面步骤自己装、自己跑。

用户的原话通常很短，例如"帮我提取这个视频的字幕""这个视频讲了什么""总结这条链接的要点"。你的任务：拿到逐字稿 → 交付字幕文件 → 需要时基于逐字稿回答/总结。

---

## 第 0 步：判断是否已装

先体检（一条命令，不改任何东西）：

```bash
python <skill-dir>/scripts/install.py --doctor
```

输出 JSON 里 `ok: true` 就跳过安装，直接进入第 2 步。`<skill-dir>` 是技能目录（默认 `~/.doubao/skills/video-subtitle-extractor`）。

如果根本没有这个目录、或 `ok: false`，执行第 1 步。

---

## 第 1 步：安装（一次就好）

**Windows（PowerShell）**：

```powershell
irm https://raw.githubusercontent.com/Zblac/video-subtitle-extractor/main/scripts/bootstrap.ps1 | iex
```

**macOS / Linux**：

```bash
curl -fsSL https://raw.githubusercontent.com/Zblac/video-subtitle-extractor/main/scripts/bootstrap.sh | bash
```

它做的事：下载代码 → `pip install`（faster-whisper / av / yt-dlp / zhconv，Windows 额外补 CUDA 运行库）→ 预下载 Whisper `small` 模型（约 500MB）→ 输出体检 JSON。

可覆盖的参数（装之前设成环境变量）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `VSX_DEST` | 安装目录 | `~/.doubao/skills/video-subtitle-extractor` |
| `VSX_MODEL` | 预下载模型：`base`/`small`/`medium`/`large-v3`/`none` | `small` |
| `VSX_REPO` / `VSX_REF` | 换仓库或分支 | 官方仓库 / `main` |
| `VSX_PYTHON` | 指定 Python | `python`（Win）/ `python3`（mac/Linux） |

**安装失败的兜底（按顺序试）**：

1. 网络抖动（`SSL: UNEXPECTED_EOF` / `The SSL connection could not be established`）：脚本已内置 3 次重试，仍失败就设代理再跑 —— `$env:HTTPS_PROXY="http://127.0.0.1:7890"` 或 `export HTTPS_PROXY=http://127.0.0.1:7890`。
2. GitHub 完全不通：让用户下载离线包 `https://github.com/Zblac/video-subtitle-extractor/releases/download/v1.0.0/video-subtitle-extractor.zip`，解压到技能目录，再跑 `python scripts/install.py --install-deps --model small`。
3. `pip` 太慢：加 `-i https://mirrors.ustc.edu.cn/pypi/simple`（在 install.py 的 pip 命令上）。
4. 纯 CPU 机器（无 NVIDIA 显卡）：`python scripts/install.py --install-deps --skip-gpu --model base`，转录会慢 5~10 倍，长视频要提前告诉用户。

硬性依赖：**Node.js ≥ 18**（主链路）、**Python ≥ 3.9**；`ffmpeg` 可选（抖音音画合并才需要）；CUDA 可选。

---

## 第 2 步：主流程（99% 的情况走这条）

```bash
node <skill-dir>/ytsub.js "<视频链接>" --json
```

- 链接**必须加引号**（URL 里带 `&`：PowerShell 不加引号会被截断）。
- `--json`：stdout 最后一行是结构化结果，过程日志走 stderr，方便你解析。
- 默认输出根目录 `~/.video-subtitle-extractor/out/<video-id>/`。

读到 JSON 后按这个顺序用：

1. `final.files.txt` → 逐字稿正文（后续问答/总结的依据）。
2. `final.source`：`official` = 平台/API 字幕（准确度高）；`whisper` = 本地转录（可能有同音错字）。
3. `final.dir` → 目录里还有 `subtitles.srt` / `.vtt` / `.json` / `report.json`。
4. `timings` → 给用户的耗时说明；`warnings` → 失败原因，别忽略。

常用参数：

| 参数 | 用途 |
|---|---|
| `--model base\|small\|medium\|large-v3` | 中文长视频/口音重 → `medium`；赶时间/CPU → `base` |
| `--device auto\|cuda\|cpu` | 默认 `auto`（GPU 优先，自动退 CPU） |
| `--out <dir>` | 换输出目录 |
| `--proxy <url>` | YouTube 下载代理（国内网络必需） |
| `--cookies chrome` | 从浏览器读 cookie（要登录态的站点） |
| `--no-api` | 不调第三方字幕 API，强制本地转录 |
| `--print-text` | 直接把字幕正文打到 stdout（短视频省一次读文件） |
| `--media <file>` | 直接转录本地音视频（配合第 3 步的抖音流程） |

---

## 第 3 步：平台分支（只处理你遇到的那一种）

### YouTube

- 有官方/自动字幕时 1~3 秒出结果；没配 API token 就走下载 + 转录（30 秒级）。
- 国内网络**必须**加 `--proxy`，例如 `--proxy http://127.0.0.1:7890`。
- 若报 `The current machine does not support all of the following ... 403`：加 `--cookies chrome`（先关掉 Chrome，否则 cookie 库被锁）。

### Bilibili / b23.tv

- 直接跑主流程，yt-dlp 下载后本地转录，170 秒视频冷跑约 25 秒。
- 平台自带字幕接口要登录 cookie，没 cookie 就跳过，**属正常，不是错误**。

### 抖音（v.douyin.com / douyin.com）

抖音有两条路，**先试 A，A 不成就走 B**：

**A. 直接跑主流程**（部分视频可下）：

```bash
node <skill-dir>/ytsub.js "<链接>" --json
```

若报 `Fresh cookies (not necessarily logged in) are needed` 或 `HTTP Error 403`，走 B。

**B. 浏览器取直链 → 本地下载 → 转录**（可靠路径，需要你有浏览器工具）：

1. 用浏览器打开短链，等它跳到 `https://www.douyin.com/video/<id>`。
2. 在页面里取出音画两条直链（抖音网页是音画分离的）：

```javascript
// media-video（画面）
performance.getEntriesByType('resource').map(e => e.name)
  .filter(u => /douyinvod.*media-video/.test(u))

// media-audio（音轨）
performance.getEntriesByType('resource').map(e => e.name)
  .filter(u => /douyinvod.*media-audio/.test(u))
```

3. 写成本地文件后下载合并（`media.py` 会顺带用 ffmpeg 合成 `media.mp4`）：

```bash
python <skill-dir>/python/media.py --dir "<out>/douyin-<id>" \
  --video-url "<media-video 直链>" --audio-url "<media-audio 直链>"
```

4. 转录（复用同一条链路，输出 srt/txt/json）：

```bash
node <skill-dir>/ytsub.js --media "<out>/douyin-<id>/media.mp4" --json
```

注意：直链带时效（通常几分钟），拿到就立刻下载；下载要 `Referer: https://www.douyin.com/`，`media.py` 已自动带上。

**C. 没有浏览器工具时的降级**：读抖音网页版正文，页面自己会给「章节要点」（分章节 AI 摘要）。可以用它做骨架回答，但**必须明确告诉用户这是平台摘要，不是逐字稿**，并说明拿不到逐字稿的原因。

### 其他站点

直接跑主流程。yt-dlp 能下就能转；下不了的站点，用第 3 步 B 的思路（浏览器拿直链 → `media.py` → `--media`）。

---

## 输出契约（照这个理解，别自己猜）

```json
{
  "id": "BV1xxxxxxxx",
  "title": "视频标题",
  "source": "youtube | other | local-media",
  "final": {
    "source": "official | whisper",
    "count": 121,
    "duration": 1128,
    "dir": "~/.video-subtitle-extractor/out/BV1xxxxxxxx",
    "files": { "txt": "...", "srt": "...", "vtt": "...", "json": "..." }
  },
  "stages": { "download": {...}, "api": {...}, "asr": {...} },
  "timings": { "download": 5.2, "asr": 19.1, "total": 25.4 },
  "warnings": []
}
```

- `final` 缺失 = 没产出字幕，退出码非 0，按 `warnings` 排查，**不要编造内容**。
- `stages.asr.device` 是 `cpu` 时：说明 GPU 没生效，长视频会慢，回答里可以提一句。
- `report.json` 里有每个阶段的完整日志，需要深挖时读它。

---

## 排错对照表

| 现象 | 原因 / 处理 |
|---|---|
| `未找到 node` 或 Node < 18 | 让用户装 Node 18+（或换机器），没有替代方案 |
| `Python 依赖缺失` | `python scripts/install.py --install-deps` |
| `模型加载失败` / 下载卡住 | 设 `VSX_HF_ENDPOINT=https://hf-mirror.com`（默认已是）或代理，重跑 `--model small` |
| `av ... IndexError: tuple index out of range` | 媒体文件只有画面没有音轨（音画分离站点），用第 3 步 B 的 `media.py` 合并 |
| `Fresh cookies ... needed` | 该站要新鲜 cookie：`--cookies chrome`（先关 Chrome），或走浏览器直链 |
| `Could not copy Chrome cookie database` | Chrome 正在运行占用了 cookie 库，关掉 Chrome 后重跑 |
| 转录极慢（≈ 音频时长的 1/1） | 退到了 CPU：查 `stages.asr.device`；装 CUDA 依赖或换 `base` 模型 |
| 中文输出是繁体 | 已内置 zhconv 转简；仍是繁体说明依赖没装全 |
| `SSL: UNEXPECTED_EOF` | 网络抖动，重试一次；或加 `--proxy` |
| 抖音 403 反复失败 | 别再死磕 cookie，直接走浏览器直链（B） |

---

## 性能预期（用来管理用户耐心，别让用户莫名等）

| 场景 | 耗时 |
|---|---|
| 平台有官方字幕 | 1~3 秒 |
| 170 秒视频，本地转录（RTX 3060 + small） | 约 20~25 秒（下载 5s + 模型 2s + 推理 16s） |
| 18 分钟视频（small） | 约 110 秒 |
| 纯 CPU | 约为音频时长的 0.5~1 倍 |

超过 10 分钟的视频：先告诉用户预计时间，再跑；别静默卡住。

---

## 交付规范（用户能感知的部分）

- **只要要点/总结/问答**：自己读 `subtitles.txt` 消化后回答，**不要**把几万字逐字稿糊进对话。给结论、给结构、给时间点。
- **要字幕文件**：交付 `subtitles.srt` + `subtitles.txt`（需要时再加 `.vtt` / `.json`），并说明目录位置。
- **引用原话或时间点**：从 `subtitles.json` / `srt` 的时间轴取，不要自己编时间。
- **本地转录的同音错字**（品牌名、人名、型号：昇腾/盘古/端到端 这类）：按上下文校正后再引用，必要时说明"转录有少量同音误差"。
- **不要把 token、cookie、内部路径**写进回复；不要展示 `.env` 内容。
- 回答用户的语言与用户提问一致。

---

## 自检清单（交付前过一遍）

1. 是否真的跑完了命令，而不是凭链接猜内容？
2. `final.files.txt` 是否存在、可读、句数合理（不是 0 句）？
3. 时间轴有没有被引用错？
4. 是 `whisper` 来源时，专有名词有没有校正？
5. 用户要文件时，是否把 srt/txt 真实交付了？
6. 失败时是否给了明确原因与下一步，而不是含糊其辞？

---

## 附：技能目录结构（排查时需要）

```
<skill-dir>/
├── SKILL.md                     # 技能说明（本文件在仓库里对应它）
├── ytsub.js                     # 主入口
├── lib/                         # 解析、分段、格式、yt-dlp 封装
├── python/transcribe.py         # faster-whisper 转录器
├── python/media.py              # 直链下载 + 音画合并
├── scripts/install.py           # 安装 / 体检
├── scripts/bootstrap.ps1|.sh    # 一行安装
├── scripts/publish.py           # 维护者发布
└── .env.example                 # 配置模板（token 可留空）

~/.video-subtitle-extractor/     # 数据目录（VSX_HOME 可改）
├── models/                      # Whisper 模型
├── cache/device.json            # 上次成功的设备组合
└── out/<id>/                    # 每个视频的产物
```
