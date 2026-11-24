"""
video-subtitle-extractor 安装器 / 自检器。

它做三件事：
  1) 取代码：可以是从 GitHub 拉 zip（默认），也可以复用本地目录（--source，用于开发或内网）。
  2) 装依赖：Python 包（faster-whisper / yt-dlp / zhconv，Windows 额外补 CUDA 运行库）、预下载 Whisper 模型。
  3) 自检：node / ffmpeg / 依赖 / 模型 / 目录结构，输出一份机器可读的 JSON，方便 Agent 判断能否开工。

典型用法（Agent 首次安装）：
    python scripts/install.py --bootstrap --dest "<技能目录>"
    python scripts/install.py --doctor          # 只体检，不改任何东西

典型用法（开发者本地验证）：
    python scripts/install.py --source . --install-deps
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

DEFAULT_REPO = os.environ.get("VSX_REPO", "Zblac/video-subtitle-extractor")
DEFAULT_REF = os.environ.get("VSX_REF", "main")
HF_MIRROR = os.environ.get("VSX_HF_ENDPOINT", "https://hf-mirror.com")

# 拼接写法：发布脚本按字面替换占位符时，不会把这段“未配置”判断也一起改掉
UNSET_REPO_MARK = "__GITHUB" + "_OWNER__"

REQUIRED_FILES = ["ytsub.js", "package.json", "lib/config.js", "python/transcribe.py"]


def log(msg: str) -> None:
    print(f"[install] {msg}", file=sys.stderr, flush=True)


def home_dir() -> Path:
    return Path(os.environ.get("VSX_HOME") or (Path.home() / ".video-subtitle-extractor"))


def repo_root_of(script: Path) -> Path:
    """install.py 位于 <repo>/scripts/，上一级就是包根。"""
    return script.resolve().parent.parent


# ---------------------------------------------------------------- 取代码
def fetch_repo(repo: str, ref: str, dest: Path, proxy: str = "") -> Path:
    """从 GitHub 下载 zip 并解包到 dest（去掉顶层目录）。网络抖动时自动重试 3 次。"""
    url = f"https://codeload.github.com/{repo}/zip/refs/heads/{ref}"
    log(f"下载代码 {url}")
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    with tempfile.TemporaryDirectory() as tmp:
        zpath = Path(tmp) / "repo.zip"
        last = None
        for attempt in range(1, 4):
            try:
                with opener.open(url, timeout=120) as r, open(zpath, "wb") as f:
                    shutil.copyfileobj(r, f, 1 << 20)
                last = None
                break
            except Exception as e:  # noqa: BLE001
                last = e
                log(f"下载失败（第 {attempt}/3 次）：{str(e)[:120]}")
        if last is not None:
            raise SystemExit(f"代码下载失败：{last}")
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            top = names[0].split("/")[0] if names else ""
            dest.mkdir(parents=True, exist_ok=True)
            for n in names:
                rel = n[len(top) + 1:] if top and n.startswith(top + "/") else n
                if not rel:
                    continue
                target = dest / rel
                if n.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(n) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
    return dest


# ---------------------------------------------------------------- 依赖
def pip_requirements(root: Path) -> Path:
    """按平台裁剪 requirements：非 Windows/Linux 去掉 nvidia 的 CUDA wheel。"""
    src = root / "requirements.txt"
    lines = []
    for raw in src.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if s.startswith("nvidia-") and platform.system() not in ("Windows", "Linux"):
            continue
        lines.append(raw)
    out = Path(tempfile.gettempdir()) / "vsx-requirements.txt"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def install_deps(root: Path, proxy: str = "", skip_gpu: bool = False) -> bool:
    req = pip_requirements(root)
    cmd = [sys.executable, "-m", "pip", "install", "-r", str(req)]
    if skip_gpu:
        # 只装纯 CPU 依赖：CUDA 运行库（nvidia-*）不下
        cmd = [sys.executable, "-m", "pip", "install",
               "faster-whisper==1.2.1", "av==18.1.1", "yt-dlp>=2026.10.26", "zhconv"]
    if proxy:
        cmd += ["--proxy", proxy]
    log(f"安装 Python 依赖：{' '.join(cmd[2:])}")
    p = subprocess.run(cmd, text=True)
    if p.returncode != 0:
        log("依赖安装失败（pip 返回非 0）")
        return False
    return True


def ensure_env_file(root: Path) -> None:
    env = root / ".env"
    example = root / ".env.example"
    if env.exists() or not example.exists():
        return
    env.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
    log("已从 .env.example 生成 .env（YouTube 官方字幕 API Token 可留空，缺省走本地转录）")


def download_model(root: Path, model: str, model_dir: Path, proxy: str = "") -> bool:
    if not model or model == "none":
        return True
    model_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("HF_ENDPOINT", HF_MIRROR)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if proxy:
        env.setdefault("HTTPS_PROXY", proxy)
        env.setdefault("HTTP_PROXY", proxy)
    cmd = [sys.executable, str(root / "python" / "transcribe.py"),
           "--media", "_", "--out", "_", "--model", model,
           "--model-dir", str(model_dir), "--device", "cpu", "--download-only"]
    log(f"预下载 Whisper 模型 {model} → {model_dir}")
    p = subprocess.run(cmd, text=True, env=env)
    if p.returncode != 0:
        log("模型下载失败（网络受限时可设 VSX_HF_ENDPOINT 或 HTTPS_PROXY 后重试）")
        return False
    return True


# ---------------------------------------------------------------- 自检
def check_node() -> dict:
    node = shutil.which("node")
    if not node:
        return {"ok": False, "path": None, "version": None, "hint": "未找到 node，请安装 Node.js 18+"}
    try:
        v = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "path": node, "version": None, "hint": str(e)[:120]}
    major = 0
    try:
        major = int(v.lstrip("v").split(".")[0])
    except Exception:  # noqa: BLE001
        pass
    return {"ok": major >= 18, "path": node, "version": v,
            "hint": None if major >= 18 else "Node 版本过低，需要 18+"}


def check_ffmpeg() -> dict:
    for name in ("ffmpeg", os.environ.get("VSX_FFMPEG", "")):
        if name and shutil.which(name):
            return {"ok": True, "path": shutil.which(name)}
    return {"ok": False, "path": None, "hint": "未找到 ffmpeg（合并抖音音视频轨时需要；仅转录可缺省）"}


def check_py_modules() -> dict:
    mods = {}
    for m in ("faster_whisper", "yt_dlp", "zhconv", "av"):
        try:
            __import__(m)
            mods[m] = True
        except Exception:  # noqa: BLE001
            mods[m] = False
    return {"ok": all(mods.values()), "modules": mods}


def check_model(model_dir: Path) -> dict:
    """兼容两种落盘方式：HF 缓存（models--Systran--faster-whisper-small/snapshots/.../model.bin）
    和老的平铺目录（<name>/model.bin）。"""
    if not model_dir.exists():
        return {"ok": False, "dir": str(model_dir), "models": []}
    found = set()
    for p in model_dir.rglob("model.bin"):
        for part in p.parts:
            if part.startswith("models--"):
                found.add(part.split("--")[-1].replace("faster-whisper-", ""))
        if not found:
            found.add(p.parent.name)
    return {"ok": bool(found), "dir": str(model_dir), "models": sorted(found)}


def doctor(root: Path, model_dir: Path) -> dict:
    node = check_node()
    ff = check_ffmpeg()
    py = check_py_modules()
    mdl = check_model(model_dir)
    files = {f: (root / f).exists() for f in REQUIRED_FILES}
    ok = node["ok"] and py["ok"] and all(files.values())
    return {
        "ok": ok,
        "repo_root": str(root),
        "home": str(home_dir()),
        "python": {"version": platform.python_version(), "executable": sys.executable},
        "node": node,
        "ffmpeg": ff,
        "python_modules": py,
        "model": mdl,
        "files": files,
    }


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="video-subtitle-extractor 安装 / 自检")
    ap.add_argument("--bootstrap", action="store_true", help="从 GitHub 拉取代码到 --dest")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--ref", default=DEFAULT_REF)
    ap.add_argument("--dest", default="", help="安装目标目录（技能目录）")
    ap.add_argument("--source", default="", help="本地包目录（开发模式，跳过下载）")
    ap.add_argument("--install-deps", action="store_true", help="pip 安装 Python 依赖")
    ap.add_argument("--skip-gpu", action="store_true", help="不装 CUDA 运行库（只能 CPU 转录）")
    ap.add_argument("--model", default=os.environ.get("VSX_MODEL", "small"),
                    help="预下载的 Whisper 模型（base/small/medium/large-v3，none 表示跳过）")
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--proxy", default="")
    ap.add_argument("--doctor", action="store_true", help="只做体检并输出 JSON")
    args = ap.parse_args()

    script = Path(__file__).resolve()
    root = Path(args.source).resolve() if args.source else repo_root_of(script)
    model_dir = Path(args.model_dir) if args.model_dir else home_dir() / "models"

    if args.doctor:
        print(json.dumps(doctor(root, model_dir), ensure_ascii=False, indent=2))
        return 0

    # 1) 取代码
    if args.bootstrap:
        if not args.dest:
            log("--bootstrap 需要 --dest（技能目录绝对路径）")
            return 2
        if UNSET_REPO_MARK in args.repo:
            log("仓库地址还没配置：请设置 VSX_REPO=owner/repo 或传 --repo owner/repo")
            return 2
        root = fetch_repo(args.repo, args.ref, Path(args.dest).resolve(), args.proxy)
        log(f"代码已就位：{root}")

    if not (root / "ytsub.js").exists():
        log(f"不是有效的包目录：{root}")
        return 2

    ensure_env_file(root)

    # 2) 依赖
    if args.install_deps:
        if not install_deps(root, args.proxy, args.skip_gpu):
            return 3
    if not download_model(root, args.model, model_dir, args.proxy):
        return 4

    # 3) 落安装清单 + 体检
    state = doctor(root, model_dir)
    (root / ".vsx-install.json").write_text(
        json.dumps({"installed_at": datetime.datetime.now().isoformat(timespec="seconds"),
                    "repo": args.repo, "ref": args.ref, "model": args.model, **state},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(state, ensure_ascii=False, indent=2))
    if not state["ok"]:
        log("安装完成，但自检未全绿：看上面 json 里的 node / python_modules / model / files")
        return 5
    log("安装完成，自检通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
