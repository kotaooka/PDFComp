# アイコン（icons/*.png）と SNS 共有用画像（og.png）を作り直す
#
# 図案：書類（PDF）を上下から矢印で押し縮める形。
# 文字は画像に焼き込むので、日本語フォントは Noto Sans CJK JP を使う（.ttc の index=0 が JP）。
# 実行: python tools/make_images.py [Noto Sans CJK のフォルダ]
#   既定は /usr/share/fonts/opentype/noto（Windows なら NotoSansCJK-*.ttc を置いたフォルダを指定）
import pathlib, sys
from PIL import Image, ImageDraw, ImageFont

REPO = pathlib.Path(__file__).resolve().parent.parent
FONT_DIR = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/opentype/noto")
SS = 4  # 縮小前の倍率（アンチエイリアス用）

ACCENT = (29, 92, 150)       # #1d5c96（QC Workbench のツール共通のアクセント色）
WHITE = (255, 255, 255)
GREEN = (87, 196, 131)       # 矢印（縮む）
RED = (214, 69, 60)          # PDF の帯


def font(weight, size):
    f = ImageFont.truetype(str(FONT_DIR / f"NotoSansCJK-{weight}.ttc"), size, index=0)
    assert f.getname()[0] == "Noto Sans CJK JP", f.getname()
    return f


def motif(d, ox, oy, s, label_font=None):
    """1 辺 s の正方形に、押し縮められた書類と上下の矢印を描く"""
    w = s * 0.50                     # 書類の幅
    h = s * 0.40                     # 縮んだ後の高さ
    x0, y0 = ox + (s - w) / 2, oy + (s - h) / 2
    fold = w * 0.24
    # 書類（右上を折った形）
    d.polygon([(x0, y0), (x0 + w - fold, y0), (x0 + w, y0 + fold), (x0 + w, y0 + h), (x0, y0 + h)], fill=WHITE)
    d.polygon([(x0 + w - fold, y0), (x0 + w - fold, y0 + fold), (x0 + w, y0 + fold)], fill=(200, 214, 228))
    # PDF の帯
    bh = h * 0.30
    by = y0 + h * 0.52
    d.rectangle([x0 - w * 0.08, by, x0 + w * 0.70, by + bh], fill=RED)
    if label_font:
        tw = d.textlength("PDF", font=label_font)
        bb = label_font.getbbox("PDF")
        d.text((x0 - w * 0.08 + (w * 0.78 - tw) / 2, by + (bh - (bb[3] - bb[1])) / 2 - bb[1]), "PDF", font=label_font, fill=WHITE)
    # 文字の線
    lw = max(2, s * 0.022)
    for k in range(2):
        yy = y0 + h * (0.20 + 0.15 * k)
        d.line([(x0 + w * 0.12, yy), (x0 + w * (0.62 if k else 0.50), yy)], fill=(160, 178, 196), width=round(lw))
    # 上下から押す矢印
    aw, ah = s * 0.20, s * 0.13
    cx = ox + s / 2
    for top in (True, False):
        tip = y0 - s * 0.035 if top else y0 + h + s * 0.035
        base = tip - ah if top else tip + ah
        d.polygon([(cx, tip), (cx - aw / 2, base), (cx + aw / 2, base)], fill=GREEN)
        stem = base - ah * 0.55 if top else base + ah * 0.55
        d.rectangle([cx - aw * 0.18, min(base, stem), cx + aw * 0.18, max(base, stem)], fill=GREEN)


def icon(size, maskable=False, apple=False):
    S = size * SS
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    if maskable or apple:
        d.rectangle([0, 0, S, S], fill=ACCENT)
        pad = S * (0.16 if maskable else 0.06)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.19, fill=ACCENT)
        pad = 0
    s = S - 2 * pad
    motif(d, pad, pad, s, font("Bold", round(s * 0.085)) if size >= 180 else None)
    return im.resize((size, size), Image.LANCZOS)


def og():
    W, H = 1200 * 2, 630 * 2
    im = Image.new("RGB", (W, H))
    top, bot = (28, 91, 149), (25, 80, 131)  # 他のツールの og.png と同じグラデーション
    dr = ImageDraw.Draw(im)
    for yy in range(H):
        t = yy / H
        dr.line([(0, yy), (W, yy)], fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    d = ImageDraw.Draw(im, "RGBA")
    k = 2
    d.text((72 * k, 106 * k), "QC Workbench", font=font("Regular", 26 * k), fill=(225, 234, 244))
    d.text((70 * k, 158 * k), "PDF圧縮", font=font("Bold", 74 * k), fill=WHITE)
    sub = font("Regular", 28 * k)
    d.text((72 * k, 266 * k), "インストール不要。ファイルを送信せず、", font=sub, fill=(225, 234, 244))
    d.text((72 * k, 310 * k), "ブラウザの中だけで PDF を小さくする", font=sub, fill=(225, 234, 244))
    pill = font("Regular", 22 * k)
    rows = [["4 段階の強さ", "まとめて圧縮", "ZIP で保存"], ["画質を並べて確認", "オフライン対応"]]
    y = 404 * k
    for row in rows:
        x = 72 * k
        for t in row:
            tw = d.textlength(t, font=pill)
            w = tw + 44 * k
            d.rounded_rectangle([x, y, x + w, y + 46 * k], radius=23 * k, fill=(255, 255, 255, 30), outline=(255, 255, 255, 110), width=2 * k)
            d.text((x + 22 * k, y + 8 * k), t, font=pill, fill=WHITE)
            x += w + 14 * k
        y += 64 * k
    s = 440 * k
    motif(d, 720 * k, 95 * k, s, font("Bold", round(s * 0.085)))
    return im.resize((1200, 630), Image.LANCZOS)


if __name__ == "__main__":
    (REPO / "icons").mkdir(exist_ok=True)
    icon(192).save(REPO / "icons/icon-192.png")
    icon(512).save(REPO / "icons/icon-512.png")
    icon(512, maskable=True).save(REPO / "icons/icon-maskable-512.png")
    icon(180, apple=True).convert("RGB").save(REPO / "icons/apple-touch-icon.png")
    og().save(REPO / "og.png", optimize=True)
    print("icons/*.png と og.png を書き出した")
