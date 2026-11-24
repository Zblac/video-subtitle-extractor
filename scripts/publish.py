"""
把本仓库发布到 GitHub：建仓 → 替换占位符 → 推送 → 打 tag → 发 release（带 zip 附件）。

给维护者用，普通用户用不到。需要一枚有 `repo` 权限的 Personal Access Token：
    $env:GITHUB_TOKEN="ghp_xxx"; python scripts/publish.py --private

会做的事：
  1. GET /user 拿到登录名；
  2. 仓库不存在就创建；
  3. 把文件里的 Zblac 换成真实 owner（只改文本文件，idempotent）；
  4. git init / commit / push 到 main；
  5. 打 tag 并创建 Release，上传源码 zip。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

API = "https://api.github.com"
TEXT_EXT = {".md", ".py", ".ps1", ".sh", ".js", ".json", ".txt", ".yml", ".yaml", ".example"}
SKIP_DIRS = {".git", "out", "models", "node_modules", "__pycache__", "cookies", ".cache"}
PLACEHOLDER = "__GITHUB" + "_OWNER__"  # 拼接写法：自身被替换过一次也不会失效


def log(msg: str) -> None:
    print(f"[publish] {msg}", file=sys.stderr, flush=True)


class GH:
    def __init__(self, token: str, proxy: str = ""):
        self.token = token
        handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
        self.opener = urllib.request.build_opener(*handlers)

    def req(self, method: str, path: str, payload=None, raw: bytes | None = None,
            content_type: str = "application/json"):
        url = path if path.startswith("http") else API + path
        data = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        r = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "vsx-publisher",
            "Content-Type": content_type,
        })
        try:
            with self.opener.open(r, timeout=120) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                if body and ("json" in ctype or ctype == ""):
                    try:
                        return resp.status, json.loads(body)
                    except Exception:  # noqa: BLE001
                        return resp.status, body
                return resp.status, body
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                parsed = json.loads(body)
            except Exception:  # noqa: BLE001
                parsed = {"message": body[:200].decode("utf-8", "ignore")}
            return e.code, parsed


def run(cmd: list[str], cwd: Path, check: bool = True) -> None:
    log("$ " + " ".join(c if "token" not in c else "<redacted>" for c in cmd))
    p = subprocess.run(cmd, cwd=str(cwd), text=True, capture_output=True)
    if p.returncode != 0:
        if check:
            raise SystemExit(f"命令失败：{' '.join(cmd[:2])}\n{(p.stderr or p.stdout)[-800:]}")
        log(f"（非致命）{cmd[1]} 返回 {p.returncode}")
    return None


def git_push(remote: str, refspec: str, root: Path) -> None:
    """先按全局配置推一次；TLS/代理异常时再强制直连推一次。"""
    direct = ["-c", "http.proxy=", "-c", "https.proxy="]
    try:
        run(["git", "push", remote, refspec, "--force"], root)
        return
    except SystemExit as e:
        log(f"推送失败，尝试绕过代理重试：{str(e)[-200:]}")
    run(["git"] + direct + ["push", remote, refspec, "--force"], root)


def iter_text_files(root: Path):
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        if p.suffix in TEXT_EXT or p.name in (".env.example", "LICENSE"):
            yield p


def replace_placeholder(root: Path, owner: str) -> list[str]:
    changed = []
    for p in iter_text_files(root):
        try:
            s = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if PLACEHOLDER in s:
            p.write_text(s.replace(PLACEHOLDER, owner), encoding="utf-8")
            changed.append(str(p.relative_to(root)))
    return changed


def build_zip(root: Path) -> Path:
    out = Path(tempfile.gettempdir()) / "video-subtitle-extractor.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in root.rglob("*"):
            rel = p.relative_to(root)
            if p.is_file() and not any(part in SKIP_DIRS for part in rel.parts):
                z.write(p, str(Path("video-subtitle-extractor") / rel))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=os.environ.get("GITHUB_TOKEN", ""))
    ap.add_argument("--name", default="video-subtitle-extractor")
    ap.add_argument("--owner", default="", help="留空则用 token 对应的账号")
    ap.add_argument("--tag", default="v1.0.0")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--proxy", default="")
    args = ap.parse_args()

    if not args.token:
        log("缺少 GITHUB_TOKEN：设置环境变量或传 --token")
        return 2

    root = Path(__file__).resolve().parent.parent
    gh = GH(args.token, args.proxy)

    st, me = gh.req("GET", "/user")
    if st != 200:
        log(f"token 无效或不可用：{me.get('message')}")
        return 2
    owner = args.owner or me["login"]
    log(f"账号：{owner}（{me.get('name') or ''}）")

    st, repo = gh.req("GET", f"/repos/{owner}/{args.name}")
    if st == 404:
        body = {"name": args.name, "private": bool(args.private), "auto_init": False,
                "description": "视频链接 → 字幕：官方字幕优先，缺失走本地 faster-whisper 转录，输出 srt/vtt/txt/json",
                "has_issues": True, "has_wiki": False}
        st2, res = gh.req("POST", "/user/repos" if not args.owner else "/orgs/%s/repos" % owner, body)
        if st2 not in (200, 201):
            log(f"建仓失败：{res.get('message')}")
            return 3
        log(f"仓库已创建：{res['html_url']}")
    elif st == 200:
        log(f"仓库已存在：{repo['html_url']}")
    else:
        log(f"查询仓库失败：{repo.get('message')}")
        return 3

    changed = replace_placeholder(root, owner)
    if changed:
        log(f"替换占位符的文件 {len(changed)} 个：{', '.join(changed[:6])}{' ...' if len(changed) > 6 else ''}")

    if not (root / ".git").exists():
        run(["git", "init", "-b", "main"], root)
    run(["git", "add", "-A"], root)
    run(["git", "-c", "user.name=" + (me.get("login") or "vsx"), "-c",
         "user.email=" + f"{me.get('login')}@users.noreply.github.com",
         "commit", "-m", "feat: video-subtitle-extractor v1 初次发布"], root, check=False)

    remote = f"https://x-access-token:{args.token}@github.com/{owner}/{args.name}.git"
    git_push(remote, "HEAD:refs/heads/main", root)
    log("代码已推送 main")

    run(["git", "tag", "-f", args.tag], root)
    git_push(remote, f"refs/tags/{args.tag}", root)

    st, rel = gh.req("POST", f"/repos/{owner}/{args.name}/releases", {
        "tag_name": args.tag, "name": f"video-subtitle-extractor {args.tag}",
        "body": "首个可移植版本：一条命令拿视频字幕；Skill 自带安装器，可被 Agent 自动部署。",
    })
    if st not in (200, 201):
        st, rel = gh.req("GET", f"/repos/{owner}/{args.name}/releases/tags/{args.tag}")
    if st not in (200, 201):
        log(f"Release 创建失败：{rel.get('message')}")
        return 4

    zip_path = build_zip(root)
    # 同名附件先删掉，重复发布才不报 422
    for a in rel.get("assets", []) or []:
        gh.req("DELETE", f"/repos/{owner}/{args.name}/releases/assets/{a['id']}")
    up = rel["upload_url"].split("{")[0] + f"?name={zip_path.name}"
    st, res = gh.req("POST", up, raw=zip_path.read_bytes(), content_type="application/zip")
    if st in (200, 201):
        log(f"Release 附件已上传：{res.get('browser_download_url')}")
    else:
        log(f"附件上传失败：{res.get('message')}")

    log(f"完成：https://github.com/{owner}/{args.name}")
    log(f"其他用户安装：irm/curl 指向 scripts/bootstrap.(ps1|sh) @ {args.tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
