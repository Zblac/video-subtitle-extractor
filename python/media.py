"""
直链媒体抓取器：把「已经在浏览器里拿到的音/视频直链」下载下来，合成一个本地媒体文件。

为什么单独需要它：抖音（以及部分国内站点）的视频在网页里是音画分离的两条地址
（media-video / media-audio），yt-dlp 又需要新鲜 cookie 才能拿到详情 JSON，
所以稳妥的做法是让 Agent 用浏览器打开页面、读出两条直链，再交给这个脚本下载合并。
之后用 `node ytsub.js --media <文件>` 复用同一条转录链路。

用法：
    python python/media.py --dir <输出目录> --video-url <视频直链> --audio-url <音频直链>
    python python/media.py --dir <输出目录> --url <单个 mp4 直链>
    python python/media.py --dir <输出目录> --urls-file urls.txt   # 第 1 行视频，第 2 行音频

输出：stdout 打印一行 JSON：{"media": "...", "video": "...", "audio": "...", "bytes": N}
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")


def log(msg: str) -> None:
    print(f"[media] {msg}", file=sys.stderr, flush=True)


def fetch(url: str, dest: str, referer: str, cookie: str = "") -> str:
    """带 UA / Referer / 可选 Cookie 下载到 dest，返回路径。"""
    headers = {"User-Agent": UA, "Referer": referer or "https://www.douyin.com/"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    log(f"下载 {os.path.basename(dest)} ...")
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    size = os.path.getsize(dest)
    log(f"{os.path.basename(dest)} {size / 1048576:.1f} MB")
    return dest


def mux(video: str, audio: str, out: str) -> bool:
    """用 ffmpeg 无损合并音视频轨；没有 ffmpeg 就保留视频轨让上层决定。"""
    ffmpeg = os.environ.get("VSX_FFMPEG", "ffmpeg")
    if not shutil.which(ffmpeg):
        log("没有找到 ffmpeg，跳过合并（将只保留需要的那条轨）")
        return False
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", video, "-i", audio,
           "-c", "copy", "-map", "0:v:0", "-map", "1:a:0", out]
    log("ffmpeg 合并音视频轨 ...")
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        log(f"合并失败：{(p.stderr or '').strip()[:300]}")
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="输出目录")
    ap.add_argument("--video-url", default="")
    ap.add_argument("--audio-url", default="")
    ap.add_argument("--url", default="", help="单条完整 mp4 直链")
    ap.add_argument("--urls-file", default="", help="第 1 行视频直链，第 2 行音频直链")
    ap.add_argument("--referer", default="https://www.douyin.com/")
    ap.add_argument("--cookie", default="", help="可选 Cookie 串")
    ap.add_argument("--name", default="media")
    args = ap.parse_args()

    os.makedirs(args.dir, exist_ok=True)

    if args.urls_file:
        with open(args.urls_file, "r", encoding="utf-8") as f:
            lines = [x.strip() for x in f.read().splitlines() if x.strip()]
        if lines:
            args.video_url = args.video_url or lines[0]
        if len(lines) > 1:
            args.audio_url = args.audio_url or lines[1]

    result = {"media": None, "video": None, "audio": None, "bytes": 0}

    if args.url:
        dest = os.path.join(args.dir, f"{args.name}.mp4")
        fetch(args.url, dest, args.referer, args.cookie)
        result.update(media=dest, video=dest, bytes=os.path.getsize(dest))
    elif args.video_url or args.audio_url:
        vpath = apath = None
        if args.video_url:
            vpath = fetch(args.video_url, os.path.join(args.dir, "video.mp4"), args.referer, args.cookie)
            result["video"] = vpath
        if args.audio_url:
            apath = fetch(args.audio_url, os.path.join(args.dir, "audio.mp4"), args.referer, args.cookie)
            result["audio"] = apath
        target = os.path.join(args.dir, f"{args.name}.mp4")
        if vpath and apath and mux(vpath, apath, target):
            result.update(media=target, bytes=os.path.getsize(target))
        elif apath:  # 合并不了：音频轨才是转录真正需要的
            result.update(media=apath, bytes=os.path.getsize(apath))
        elif vpath:
            result.update(media=vpath, bytes=os.path.getsize(vpath))
    else:
        log("没有给出任何直链")
        return 2

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["media"] else 1


if __name__ == "__main__":
    sys.exit(main())
