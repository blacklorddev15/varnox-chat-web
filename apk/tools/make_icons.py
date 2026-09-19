"""Build the VARNOX launcher icon set from the brand artwork.

Source: assets/icon-source.png (627x627, gold V + circular chat bubble + crown + dots,
        dark backdrop, gold border frame, "VARNOX CHAT" wordmark at the bottom).

Outputs
  res/mipmap-*/ic_launcher.png            legacy full artwork (API 24-25 launchers)
  res/mipmap-*/ic_launcher_foreground.png adaptive foreground: emblem only, scaled to the
                                          adaptive-icon safe zone so the V and the circle
                                          can never be clipped by an OEM mask
  res/mipmap-anydpi-v26/ic_launcher.xml   adaptive icon wiring (see res/ for the XML)

Rationale: a launcher mask crops roughly the outer third of an adaptive icon, so the frame
and wordmark are dropped from the foreground and the emblem is sized to a 64dp bounding
circle inside the 66dp safe zone.
"""
from PIL import Image, ImageChops, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
SRC = os.path.join(PROJ, "assets", "icon-source.png")
RES = os.path.join(PROJ, "res")

LEGACY = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
          "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
# adaptive icon canvas is 108dp; xxxhdpi = 4x -> 432px
FOREGROUND = {"mipmap-mdpi": 108, "mipmap-hdpi": 162, "mipmap-xhdpi": 216,
              "mipmap-xxhdpi": 324, "mipmap-xxxhdpi": 432}

BACKGROUND = (0, 0, 0, 255)   # artwork backdrop is black
MARK_CIRCLE_DP = 64.0         # bounding circle the emblem is fitted into

# Luminance -> alpha: the backdrop (luma <= 12) drops out, gold (luma >= 92) is opaque,
# the glow between the two is kept as a soft ramp.
LUMINANCE_LUT = [0 if v <= 12 else min(255, int(round(255 * ((v - 12) / 80.0) ** 0.85)))
                 for v in range(256)]

# Emblem bounds measured on assets/icon-source.png (627x627): crown finial top to the
# bubble tail, left/right extremes of the bubble ring. Excludes the gold border frame
# and the "VARNOX CHAT" wordmark (wordmark starts at y~425).
EMBLEM_BOX = (150, 45, 502, 422)
CANVAS_PAD = 1.22             # black breathing room around the emblem before feathering


def unpremultiply(im):
    """Undo the darkening that alpha-keying causes once the layer sits on black.

    Compositing gives colour*alpha, so dividing the colour by alpha restores the exact
    artwork tone instead of a dimmed version of it.
    """
    import numpy as np

    arr = np.asarray(im).astype(np.float32)
    rgb, a = arr[..., :3], arr[..., 3:4]
    boosted = np.where(a > 0, rgb * (255.0 / np.maximum(a, 1.0)), 0.0)
    out = np.concatenate([np.clip(boosted, 0, 255), a], axis=-1).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def is_gold(p):
    return p[0] > 110 and p[1] > 70 and p[2] < 140 and (p[0] - p[2]) > 40


def find_emblem_box(im):
    """Bounding box of the emblem (crown + bubble + V + dots), excluding frame and wordmark."""
    px = im.load()
    w, h = im.size
    margin = 75          # keeps the gold border frame out of the search window
    min_hits = 12        # ignores frame glow bleeding into the window
    x0, x1 = margin, w - margin
    y0, y1 = margin, h - margin

    cols = [sum(1 for y in range(y0, y1) if is_gold(px[x, y])) for x in range(w)]
    rows = [sum(1 for x in range(x0, x1) if is_gold(px[x, y])) for y in range(h)]

    xs = [x for x in range(x0, x1) if cols[x] >= min_hits]
    ys = [y for y in range(y0, y1) if rows[y] >= min_hits]
    return min(xs), min(ys), max(xs), max(ys)


def emblem_layer(im, size_px, mark_circle_dp=MARK_CIRCLE_DP):
    """Emblem cut out of the artwork and centred in a 108dp canvas rendered at `size_px`.

    The artwork's backdrop is near-black and the emblem is luminous gold, so the alpha is
    keyed off luminance: the plate vanishes entirely and the gold keeps its glow, which
    means no square crop edge can show against the flat background under the mask.
    The emblem's bounding circle is fitted to `mark_circle_dp` so the V, the bubble ring,
    the crown and the dots all stay inside the adaptive-icon safe zone.
    """
    src = im.convert("RGBA")
    bx0, by0, bx1, by1 = EMBLEM_BOX
    bx0, by0 = max(0, bx0), max(0, by0)
    bx1, by1 = min(im.width, bx1), min(im.height, by1)
    bw, bh = bx1 - bx0, by1 - by0

    emblem = src.crop((bx0, by0, bx1, by1))
    alpha = emblem.convert("L").point(LUMINANCE_LUT)
    emblem.putalpha(alpha)
    emblem = unpremultiply(emblem)

    diag = (bw ** 2 + bh ** 2) ** 0.5
    target_circle = size_px * (mark_circle_dp / 108.0)
    scale = target_circle / diag
    drawn_w, drawn_h = max(1, int(round(bw * scale))), max(1, int(round(bh * scale)))
    emblem = emblem.resize((drawn_w, drawn_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (size_px, size_px), (0, 0, 0, 0))
    canvas.paste(emblem, ((size_px - drawn_w) // 2, (size_px - drawn_h) // 2), emblem)
    return canvas


def main():
    im = Image.open(SRC)
    box = find_emblem_box(im)
    print("emblem box:", box, "->", (box[2] - box[0] + 1, box[3] - box[1] + 1))

    for folder, px in LEGACY.items():
        d = os.path.join(RES, folder)
        os.makedirs(d, exist_ok=True)
        im.resize((px, px), Image.LANCZOS).convert("RGBA").save(os.path.join(d, "ic_launcher.png"))
        print("legacy", folder, px)

    for folder, px in FOREGROUND.items():
        d = os.path.join(RES, folder)
        os.makedirs(d, exist_ok=True)
        emblem_layer(im, px).save(os.path.join(d, "ic_launcher_foreground.png"))
        print("foreground", folder, px)

    # mask-simulation preview so the icon can be eyeballed before installing
    preview_side = 432
    fg = emblem_layer(im, preview_side)
    composed = Image.new("RGBA", (preview_side, preview_side), BACKGROUND)
    composed.alpha_composite(fg)

    panels = []
    for shape in ("circle", "squircle", "legacy"):
        panel = Image.new("RGBA", (preview_side, preview_side), (0, 0, 0, 0))
        if shape == "legacy":
            panel.alpha_composite(im.resize((preview_side, preview_side),
                                            Image.LANCZOS).convert("RGBA"))
        else:
            panel.alpha_composite(composed)
            m = Image.new("L", (preview_side, preview_side), 0)
            md = ImageDraw.Draw(m)
            if shape == "circle":
                dia = int(preview_side * 0.70)
                o = (preview_side - dia) // 2
                md.ellipse([o, o, o + dia, o + dia], fill=255)
            else:
                md.rounded_rectangle([0, 0, preview_side - 1, preview_side - 1],
                                     radius=int(preview_side * 0.30), fill=255)
            panel.putalpha(m)
        panels.append(panel)

    gap = 24
    sheet = Image.new("RGBA", (preview_side * 3 + gap * 4, preview_side + gap * 2),
                      (24, 24, 28, 255))
    for i, p in enumerate(panels):
        sheet.alpha_composite(p, (gap + i * (preview_side + gap), gap))
    sheet.resize((sheet.width // 2, sheet.height // 2), Image.LANCZOS) \
         .convert("RGB").save(os.path.join(PROJ, "icon-preview.png"))
    print("preview:", os.path.join(PROJ, "icon-preview.png"))


if __name__ == "__main__":
    main()
