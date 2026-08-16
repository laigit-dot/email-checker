"""Compose Email Checker app icons from the Lucide mail-check glyph (ISC)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "build" / "icons" / "mail-check-white.png"
OUT_DIR = ROOT / "build"
ICONS_DIR = ROOT / "build" / "icons"


def lerp(a: tuple[int, ...], b: tuple[int, ...], t: float) -> tuple[int, ...]:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Missing source glyph: {SRC}")

    glyph_src = Image.open(SRC).convert("RGBA")
    # Soft teal matching the Email Checker / emailglass UI.
    bg_top = (122, 168, 158, 255)
    bg_bottom = (79, 122, 116, 255)

    size = 512
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = 112
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        fill=255,
    )

    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=lerp(bg_top, bg_bottom, y / (size - 1)))
    canvas.paste(grad, (0, 0), mask)

    glyph = glyph_src.resize((300, 300), Image.Resampling.LANCZOS)
    gx = (size - glyph.width) // 2
    gy = (size - glyph.height) // 2 - 8
    canvas.alpha_composite(glyph, (gx, gy))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    png_path = OUT_DIR / "icon.png"
    canvas.save(png_path, "PNG")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [canvas.resize((s, s), Image.Resampling.LANCZOS) for s in sizes]
    ico_path = OUT_DIR / "icon.ico"
    ico_images[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])

    for s in (16, 32, 48, 128, 256, 512):
        canvas.resize((s, s), Image.Resampling.LANCZOS).save(ICONS_DIR / f"icon-{s}.png")

    # Favicon-friendly copies for the renderer / Vite public assets.
    assets = ROOT / "src" / "renderer" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    public = ROOT / "public"
    public.mkdir(parents=True, exist_ok=True)
    favicon = canvas.resize((128, 128), Image.Resampling.LANCZOS)
    favicon.save(assets / "app-icon.png")
    favicon.save(public / "app-icon.png")
    ico_images[-1].save(public / "favicon.ico", format="ICO", sizes=[(s, s) for s in sizes])

    print(f"wrote {png_path}")
    print(f"wrote {ico_path}")
    print(f"wrote {assets / 'app-icon.png'}")
    print(f"wrote {public / 'app-icon.png'}")
    print(f"wrote {public / 'favicon.ico'}")


if __name__ == "__main__":
    main()
