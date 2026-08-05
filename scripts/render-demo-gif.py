#!/usr/bin/env python3
"""Render the README terminal demo as a smooth, deterministic animated GIF."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "demo.gif"
POSTER = ROOT / "assets" / "demo.png"
VIDEO = ROOT / "assets" / "demo.mp4"

WIDTH, HEIGHT = 840, 400
FPS, SECONDS = 30, 12
FONT_CANDIDATES = [
    os.environ.get("FINANCE_MCP_DEMO_FONT"),
    "/System/Library/Fonts/SFNSMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "DejaVuSansMono.ttf",
]
for font_path in FONT_CANDIDATES:
    if not font_path:
        continue
    try:
        FONT = ImageFont.truetype(font_path, 14)
        break
    except OSError:
        pass
else:
    raise RuntimeError("Set FINANCE_MCP_DEMO_FONT to a monospaced TrueType font")

BG = "#0d1117"
BAR = "#161b22"
BORDER = "#30363d"
DIM = "#8b949e"
BASE = "#c9d1d9"
GREEN = "#3fb950"
BLUE = "#58a6ff"
PURPLE = "#bc8cff"
YELLOW = "#d29922"


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def ease(value: float) -> float:
    value = clamp(value)
    return 1.0 - (1.0 - value) ** 3


def alpha_at(now: float, start: float, fade: float = 0.28) -> float:
    appear = ease((now - start) / fade)
    disappear = 1.0 - ease((now - 10.8) / 0.65)
    return clamp(min(appear, disappear))


def with_alpha(color: str, alpha: float) -> tuple[int, int, int, int]:
    color = color.removeprefix("#")
    return tuple(int(color[i : i + 2], 16) for i in (0, 2, 4)) + (round(255 * alpha),)


def segments(draw: ImageDraw.ImageDraw, xy: tuple[float, float], parts, alpha: float = 1.0):
    x, y = xy
    for text, color in parts:
        draw.text((x, y), text, font=FONT, fill=with_alpha(color, alpha))
        x += draw.textlength(text, font=FONT)


def line(layer: Image.Image, now: float, start: float, y: int, parts):
    alpha = alpha_at(now, start)
    if alpha <= 0:
        return
    slide = round(5 * (1.0 - ease((now - start) / 0.34)))
    segments(ImageDraw.Draw(layer), (26 + slide, y), parts, alpha)


def frame_at(now: float) -> Image.Image:
    image = Image.new("RGBA", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, WIDTH - 1, HEIGHT - 1), radius=10, fill=BG, outline=BORDER)
    draw.rectangle((1, 1, WIDTH - 2, 38), fill=BAR)
    draw.ellipse((18, 13, 30, 25), fill="#ff5f56")
    draw.ellipse((38, 13, 50, 25), fill="#ffbd2e")
    draw.ellipse((58, 13, 70, 25), fill="#27c93f")
    title = "finance-mcp"
    title_width = draw.textlength(title, font=FONT)
    draw.text(((WIDTH - title_width) / 2, 9), title, font=FONT, fill=DIM)

    content = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(content)
    prompt = "What's Apple trading at, and how has NVDA done this month?"
    prompt_progress = ease((now - 0.35) / 2.15)
    prompt_alpha = 1.0 - ease((now - 10.8) / 0.65)
    shown = prompt[: round(len(prompt) * clamp(prompt_progress))]
    segments(cdraw, (26, 56), [("> ", GREEN), (shown, BASE)], prompt_alpha)

    line(content, now, 2.85, 92, [("call  ", DIM), ("get_stock_quote", PURPLE), ('  symbols: ["AAPL"]', DIM)])
    line(content, now, 3.20, 113, [("call  ", DIM), ("get_price_history", PURPLE), ('  symbol: "NVDA", range: "1mo"', DIM)])

    line(content, now, 4.00, 147, [("AAPL", BLUE), (" — Apple Inc.", DIM)])
    line(content, now, 4.25, 168, [("  Price:      ", DIM), ("$309.38", BASE), ("  +5.96  (+1.96%)", GREEN)])
    line(content, now, 4.48, 189, [("  52w range:  ", DIM), ("$202.16 – $344.57", BASE)])
    line(content, now, 4.71, 210, [("  Volume:     ", DIM), ("67.78M", BASE)])

    line(content, now, 5.35, 244, [("NVDA", BLUE), (" — NVIDIA Corporation  (1mo, 1d, USD)", DIM)])
    line(content, now, 5.60, 265, [("  Period return:  ", DIM), ("+8.38%", GREEN), ("   $195.55 → $211.94", DIM)])
    line(content, now, 5.83, 286, [("  Period high:    ", DIM), ("$214.39", BASE)])
    line(content, now, 6.06, 307, [("  Period low:     ", DIM), ("$190.01", BASE)])
    line(content, now, 6.70, 341, [("✓", YELLOW), ("  Live data · no API key · 10 tools", DIM)])

    cursor_alpha = alpha_at(now, 6.7) * (1.0 if int(now * 2.2) % 2 == 0 else 0.18)
    cdraw.rectangle((335, 342, 342, 354), fill=with_alpha(GREEN, cursor_alpha))

    image.alpha_composite(content)
    return image.convert("RGB")


def main():
    rgb_frames = [frame_at(i / FPS) for i in range(FPS * SECONDS)]
    rgb_frames[round(8.0 * FPS)].save(POSTER, optimize=True)

    palette = rgb_frames[round(8.0 * FPS)].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    frames = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in rgb_frames]
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=round(1000 / FPS),
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024 / 1024:.2f} MiB)")
    print(f"wrote {POSTER} ({POSTER.stat().st_size / 1024:.0f} KiB)")

    ffmpeg = os.environ.get("FFMPEG")
    if ffmpeg:
        video_fps = 60
        command = [
            ffmpeg,
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            f"{WIDTH}x{HEIGHT}",
            "-framerate",
            str(video_fps),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(VIDEO),
        ]
        process = subprocess.Popen(command, stdin=subprocess.PIPE)
        assert process.stdin is not None
        for index in range(video_fps * SECONDS):
            process.stdin.write(frame_at(index / video_fps).tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("ffmpeg failed to render the demo video")
        print(f"wrote {VIDEO} ({VIDEO.stat().st_size / 1024 / 1024:.2f} MiB, {video_fps} fps)")


if __name__ == "__main__":
    main()
