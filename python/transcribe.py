"""
whisper 转录工作进程（由 ytsub.js 调用，也可单独运行）。

来源说明：模型加载 / VAD / beam_size 等参数沿用参考项目 whisper-service/app.py 的
转录核心（faster-whisper 1.2.1，CPU int8 默认），此处去掉 Flask，改为一次性命令行：
    python transcribe.py --media video.mp4 --out asr.json --model small --model-dir ./models

输出 JSON：{ model, device, compute_type, language, language_probability, segments:[{start,end,text}] }
所有进度写 stderr，stdout 只用于最终结果路径，方便上层解析。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time


def log(msg: str) -> None:
    print(f"[whisper] {msg}", file=sys.stderr, flush=True)


def prepare_cuda_libs() -> None:
    """Windows 上 pip 装的 nvidia-cublas-cu12 / nvidia-cudnn-cu12 只提供 DLL，
    没有 CUDA Toolkit 时 ctranslate2 找不到 cublas64_12.dll，会在 encode 阶段报错。
    这里把 site-packages/nvidia/*/bin 全部加进 DLL 搜索路径（PATH + add_dll_directory）。"""
    if os.name != "nt":
        return
    try:
        import glob
        import site
    except Exception:  # noqa: BLE001
        return
    roots = []
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        roots.append(base)
    found = []
    for base in roots:
        for d in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            if os.path.isdir(d):
                found.append(d)
    if found:
        os.environ["PATH"] = os.pathsep.join(found + [os.environ.get("PATH", "")])
        for d in found:
            try:
                os.add_dll_directory(d)
            except Exception:  # noqa: BLE001
                pass
        log(f"已挂载 CUDA 运行库目录 {len(found)} 个（{os.path.basename(os.path.dirname(found[0]))} 等）")


def state_home() -> str:
    """用户级状态目录，默认 ~/.video-subtitle-extractor（与 Node 侧 VSX_HOME 一致）。"""
    return os.environ.get("VSX_HOME") or os.path.join(os.path.expanduser("~"), ".video-subtitle-extractor")


def default_model_dir() -> str:
    return os.environ.get("VSX_MODEL_DIR") or os.environ.get("YTSUB_MODEL_DIR") or os.path.join(state_home(), "models")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--media", required=True, help="本地视频/音频路径")
    p.add_argument("--out", required=True, help="输出 JSON 路径")
    p.add_argument("--model", default="small")
    p.add_argument("--model-dir", default=default_model_dir())
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument("--compute", default="auto")
    p.add_argument("--language", default="", help="留空自动识别，如 en / zh")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--download-only", action="store_true", help="只下载并加载模型，不转录")
    return p.parse_args()


def probe_device(model) -> None:
    """用 1 秒静音真跑一次推理：CUDA 只有模型文件时能加载，
    但缺 cublas64_12.dll / cudnn 时会在 encode 阶段才炸，必须实测。"""
    import tempfile
    import wave

    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            path = f.name
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 16000)
        segments, _ = model.transcribe(path, beam_size=1, vad_filter=False, condition_on_previous_text=False)
        for _ in segments:
            break
    finally:
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass


def device_cache_path() -> str:
    return os.path.join(state_home(), "cache", "device.json")


def read_device_cache(model_size: str):
    """上一次成功跑过的设备组合；命中就直接用，省掉每次的 CUDA 试错与自检。"""
    try:
        with open(device_cache_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("model") == model_size and data.get("device") and data.get("compute"):
            return data["device"], data["compute"]
    except Exception:  # noqa: BLE001
        pass
    return None


def write_device_cache(model_size: str, device: str, compute: str) -> None:
    try:
        p = device_cache_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"model": model_size, "device": device, "compute": compute,
                       "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=2)
    except Exception:  # noqa: BLE001
        pass


def load_model(size: str, model_dir: str, device: str, compute: str):
    from faster_whisper import WhisperModel

    os.makedirs(model_dir, exist_ok=True)
    cached = read_device_cache(size) if device == "auto" and compute == "auto" else None
    if cached:
        order = [cached]
        log(f"设备缓存命中：{cached[0]}/{cached[1]}（跳过试错）")
    elif device == "auto":
        order = [("cuda", "float16"), ("cpu", "int8")]
    elif device == "cuda":
        order = [("cuda", compute if compute != "auto" else "float16")]
    else:
        order = [("cpu", compute if compute != "auto" else "int8")]

    last = None
    for dev, ctype in order:
        try:
            log(f"加载模型 {size} (device={dev}, compute={ctype}, dir={model_dir}) ...")
            t = time.time()
            model = WhisperModel(size, device=dev, compute_type=ctype, download_root=model_dir)
            log(f"模型就绪，用时 {time.time() - t:.1f}s")
            if dev == "cuda" and not cached:
                log("CUDA 自检（1 秒静音推理）...")
                probe_device(model)
                log("CUDA 可用")
            write_device_cache(size, dev, ctype)
            return model, dev, ctype
        except Exception as e:  # noqa: BLE001  cuda 缺库时自动退回 cpu
            last = e
            log(f"{dev}/{ctype} 不可用：{str(e).splitlines()[0][:160]}")
    # 全部失败：把缓存置为 cpu，下次别再试 cuda
    if cached and cached[0] == "cuda":
        try:
            os.remove(device_cache_path())
        except OSError:
            pass
    raise RuntimeError(f"模型加载失败：{last}")


def main() -> int:
    args = parse_args()
    prepare_cuda_libs()
    # 国内网络默认走 hf-mirror 下载模型（huggingface.co 直连多半超时）；
    # 想用官方源就显式设置 HF_ENDPOINT 或 YTSUB_HF_ENDPOINT。
    if not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = os.environ.get("YTSUB_HF_ENDPOINT", "https://hf-mirror.com")

    model, dev, ctype = load_model(args.model, args.model_dir, args.device, args.compute)
    if args.download_only:
        print(os.path.abspath(args.model_dir))
        return 0

    if not os.path.exists(args.media):
        log(f"找不到媒体文件：{args.media}")
        return 2

    log(f"开始转录 {args.media}")
    t = time.time()
    segments, info = model.transcribe(
        args.media,
        beam_size=args.beam_size,
        vad_filter=True,
        language=(args.language or None),
    )
    out = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        out.append({"start": round(float(s.start), 3), "end": round(float(s.end), 3), "text": text})
        if len(out) % 50 == 0:
            log(f"已转 {len(out)} 段，最后 {s.end:.0f}s")

    payload = {
        "model": args.model,
        "device": dev,
        "compute_type": ctype,
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "elapsed": round(time.time() - t, 1),
        "segments": out,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"完成：{len(out)} 段，耗时 {payload['elapsed']}s，语言 {payload['language']}")
    print(os.path.abspath(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
