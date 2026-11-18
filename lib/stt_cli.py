# -*- coding: utf-8 -*-
"""dsh-onebot-genji 内置语音转写桥（custom STT 引擎的默认实现）。

插件的 custom 引擎**不读 stdout**，它只读工作目录里的第一个 .txt
（`readFirstTxt(workDir)`），所以这里必须把结果写到 `<out>.txt`。

调用方式（插件会自动拼好，用户不用管）：
    python stt_cli.py <audio> <out-prefix> [--model small] [--server URL] [--no-server]

向后兼容：不带任何选项时行为与旧版一致 —— 先问常驻服务 127.0.0.1:9891，
连不上再本地加载 faster-whisper 兜底模型。

依赖只要求一个：`pip install faster-whisper`
（没有它、又连不上常驻服务时，会把安装提示打到 stderr 并以退出码 3 结束，
插件侧表现为这一条语音转写失败，不会污染其它功能）。

环境变量：
    DS_STT_SERVER   常驻服务地址，默认 http://127.0.0.1:9891/transcribe；空串=禁用
    DS_STT_MODEL    本地兜底模型，默认 small
    DS_STT_CACHE    faster-whisper 模型缓存目录（默认 huggingface 缓存）
    DS_STT_LANG     语言，默认 zh
"""
import json
import logging
import os
import sys
import urllib.request

DEFAULT_SERVER = "http://127.0.0.1:9891/transcribe"
SERVER_TIMEOUT = 20
DEFAULT_MODEL = "small"
DEFAULT_LANG = "zh"

logging.getLogger("faster_whisper").setLevel(logging.ERROR)


def parse_argv(argv):
    """极简参数解析：前两个位置参数是 <audio> <out-prefix>，其余是选项。"""
    opts = {
        "server": os.environ.get("DS_STT_SERVER", DEFAULT_SERVER),
        "model": os.environ.get("DS_STT_MODEL", DEFAULT_MODEL),
        "cache": os.environ.get("DS_STT_CACHE", "") or None,
        "lang": os.environ.get("DS_STT_LANG", DEFAULT_LANG),
    }
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-server":
            opts["server"] = ""
        elif a == "--server" and i + 1 < len(argv):
            i += 1
            opts["server"] = argv[i]
        elif a == "--model" and i + 1 < len(argv):
            i += 1
            opts["model"] = argv[i]
        elif a == "--cache" and i + 1 < len(argv):
            i += 1
            opts["cache"] = argv[i]
        elif a == "--lang" and i + 1 < len(argv):
            i += 1
            opts["lang"] = argv[i]
        elif a.startswith("--"):
            pass  # 未知选项直接忽略，别因为插件以后加参数就整体失败
        else:
            positional.append(a)
        i += 1
    return positional, opts


def via_server(src, server):
    """交给常驻服务转写；没配地址、连不上或报错都返回 None。"""
    if not server:
        return None
    try:
        body = json.dumps({"path": src}).encode("utf-8")
        req = urllib.request.Request(
            server, data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=SERVER_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data.get("text")
        return text if isinstance(text, str) and text.strip() else None
    except Exception:
        return None


def via_local(src, opts):
    """本地兜底：默认 small（比 medium 快 3~4 倍，中文短句够用）。"""
    try:
        import faster_whisper
    except ImportError:
        sys.stderr.write(
            "STT: 缺少 Python 依赖 faster-whisper。\n"
            "     装一个就好：pip install faster-whisper\n"
            "     （或者启动常驻转写服务并在设置里填它的地址 / 用 whisper-cli 之类的外部引擎）\n"
        )
        raise SystemExit(3)
    kwargs = {}
    if opts["cache"]:
        kwargs["download_root"] = opts["cache"]
    model = faster_whisper.WhisperModel(
        opts["model"], device="cpu", compute_type="int8", **kwargs
    )
    segments, _info = model.transcribe(
        src, language=opts["lang"], beam_size=5, vad_filter=False
    )
    return "".join(s.text for s in segments).strip()


def main():
    positional, opts = parse_argv(sys.argv[1:])
    if not positional:
        sys.stderr.write(
            "usage: stt_cli.py <audio> [out-prefix] "
            "[--model NAME] [--server URL] [--no-server] [--cache DIR] [--lang LANG]\n"
        )
        return 2
    src = positional[0]
    out_prefix = positional[1] if len(positional) > 1 else ""

    text = via_server(src, opts["server"])
    if text is None:
        text = via_local(src, opts)

    if out_prefix:
        with open(out_prefix + ".txt", "w", encoding="utf-8") as f:
            f.write(text)
    sys.stdout.write(text)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
