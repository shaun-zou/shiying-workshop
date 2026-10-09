#!/usr/bin/env python3
"""诗影工坊 · Edge 神经语音：单段合成（文本文件 → mp3）

用法：
  python edge_tts_once.py --text-file seg.txt --out seg.mp3 \
      --voice zh-CN-YunjianNeural --rate -8% --pitch +0Hz --volume +0%

说明：调用微软 Edge 朗读服务的神经语音（无需 API Key，需联网）。
失败时自动重试一次；重试仍失败则以非零退出码返回。
"""
import argparse
import asyncio
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="zh-CN-YunjianNeural")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--volume", default="+0%")

    # 兼容 "--rate -8%" 这类以负号开头的值（argparse 会误判为选项）：预处理为 --rate=-8%
    raw = sys.argv[1:]
    fixed = []
    i = 0
    while i < len(raw):
        token = raw[i]
        if token in ("--rate", "--pitch", "--volume") and i + 1 < len(raw) and raw[i + 1][:1] in ("-", "+"):
            fixed.append(f"{token}={raw[i + 1]}")
            i += 2
            continue
        fixed.append(token)
        i += 1
    args = ap.parse_args(fixed)

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        print("ERROR: empty text", file=sys.stderr)
        return 2

    import edge_tts  # 延迟导入，保持错误信息清晰

    async def synth() -> None:
        communicate = edge_tts.Communicate(
            text, args.voice, rate=args.rate, pitch=args.pitch, volume=args.volume
        )
        await communicate.save(args.out)

    last_err = None
    for attempt in range(2):
        try:
            asyncio.run(synth())
            return 0
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt == 0:
                time.sleep(1.2)
    print(f"ERROR: edge tts failed: {last_err}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
