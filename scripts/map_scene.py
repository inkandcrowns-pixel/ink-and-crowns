"""Vintage ink map scene -> PNG frames (then FFmpeg makes the clip).
Usage: python -I map_scene.py <out_dir> <lon> <lat> "<LABEL>" "<sub label>" [seconds=5] [w=1280] [h=720]
Natural Earth 10m admin-0 (public domain), from ~/VideoAssets/maps/ne_10m_ind.geojson.
Look: aged parchment, ink coastline with old-map water lines, slow push-in to the place, pin + label."""
import json, math, os, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

out, lon0, lat0, label, sub = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4], sys.argv[5]
secs = float(sys.argv[6]) if len(sys.argv) > 6 else 5.0
W = int(sys.argv[7]) if len(sys.argv) > 7 else 1280
H = int(sys.argv[8]) if len(sys.argv) > 8 else 720
FPS = 30
os.makedirs(out, exist_ok=True)

INK = (43, 33, 24)
ACCENT = (160, 32, 24)
PAPER = (176, 205, 196)      # sea: faded teal watercolour wash (colour, not plain paper: feedback 2026-11-01)
LAND = (226, 196, 128)       # land: warm ochre

geo = json.load(open(os.path.expanduser("~/VideoAssets/maps/ne_10m_ind.geojson"), encoding="utf-8"))
polys = []
for f in geo["features"]:
    g = f["geometry"]
    for p in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
        ring = p[0]
        xs = [c[0] for c in ring]; ys = [c[1] for c in ring]
        if max(xs) < lon0 - 40 or min(xs) > lon0 + 40 or max(ys) < lat0 - 30 or min(ys) > lat0 + 30:
            continue
        polys.append(ring)

def merc(lo, la):
    return math.radians(lo), math.log(math.tan(math.pi / 4 + math.radians(la) / 2))

cx, cy = merc(lon0, lat0)

def paper_texture():
    random.seed(7)
    img = Image.new("RGB", (W, H), PAPER)
    noise = Image.effect_noise((W, H), 22).convert("L").filter(ImageFilter.GaussianBlur(1.2))
    tint = Image.new("RGB", (W, H), (150, 186, 180))
    img = Image.composite(tint, img, noise.point(lambda v: max(0, v - 128) // 3))
    # darker, burnt edges
    vign = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(vign)
    for i in range(60):
        d.rectangle([i * 3, i * 3, W - i * 3, H - i * 3], outline=int(150 - i * 2.5))
    vign = vign.filter(ImageFilter.GaussianBlur(25))
    return Image.composite(Image.new("RGB", (W, H), (150, 115, 75)), img, vign)

BASE = paper_texture()
serif = "C:/Windows/Fonts/georgiab.ttf"
serif_i = "C:/Windows/Fonts/georgiai.ttf"
f_label = ImageFont.truetype(serif, int(H * 0.062))
f_sub = ImageFont.truetype(serif_i, int(H * 0.033))

def ease(t):
    return t * t * (3 - 2 * t)

n = int(secs * FPS)
for k in range(n):
    t = k / max(1, n - 1)
    # push-in: from ~2200 km wide view to ~180 km
    span = math.exp(math.log(0.62) + (math.log(0.05) - math.log(0.62)) * ease(min(1, t * 1.15)))
    scale = W / span
    def P(lo, la):
        x, y = merc(lo, la)
        return (W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale)
    img = BASE.copy()
    d = ImageDraw.Draw(img, "RGBA")
    shapes = []
    for ring in polys:
        pts = [P(lo, la) for lo, la in ring[::1 if span < 0.2 else 3]]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        if max(xs) < -50 or min(xs) > W + 50 or max(ys) < -50 or min(ys) > H + 50 or len(pts) < 3:
            continue
        shapes.append(pts)
    # old-map water lines: coastline echoed outward in fading ink
    for off, a in ((7, 120), (15, 80), (25, 45)):
        for pts in shapes:
            d.line(pts + [pts[0]], fill=(40, 80, 90, a), width=off, joint="curve")
    for pts in shapes:
        d.polygon(pts, fill=LAND + (255,))
    # land texture: a soft green-brown watercolour bloom inland + faint hatching
    for pts in shapes:
        d.line(pts + [pts[0]], fill=(190, 150, 80, 160), width=10, joint="curve")
    for y in range(0, H, 7):
        d.line([(0, y), (W, y)], fill=INK + (10,), width=1)
    for pts in shapes:
        d.line(pts + [pts[0]], fill=INK + (235,), width=3, joint="curve")
    # pin + label fade in after the camera settles
    a = ease(max(0, min(1, (t - 0.55) / 0.3)))
    if a > 0:
        px, py = W / 2, H / 2
        r = H * 0.014 * (1 + 0.3 * (1 - a))
        d.ellipse([px - r * 2.6, py - r * 2.6, px + r * 2.6, py + r * 2.6], outline=ACCENT + (int(160 * a),), width=3)
        d.ellipse([px - r, py - r, px + r, py + r], fill=ACCENT + (int(255 * a),))
        # label on the land (west) side, right-aligned, so it never sits on the coastline/sea
        tw = max(d.textlength(label, font=f_label), d.textlength(sub, font=f_sub))
        lx, ly = px - H * 0.07 - tw, py - H * 0.11
        d.line([(px - r * 2.6, py - r), (lx + tw + 6, ly + H * 0.05)], fill=INK + (int(220 * a),), width=2)
        d.text((lx + tw - d.textlength(label, font=f_label), ly), label, font=f_label, fill=INK + (int(255 * a),))
        d.text((lx + tw - d.textlength(sub, font=f_sub), ly + H * 0.075), sub, font=f_sub, fill=ACCENT + (int(255 * a),))
    # compass mark, bottom-right
    ccx, ccy, cr = W - H * 0.12, H - H * 0.14, H * 0.06
    d.polygon([(ccx, ccy - cr), (ccx + cr * 0.18, ccy), (ccx, ccy + cr), (ccx - cr * 0.18, ccy)], outline=INK + (200,), fill=INK + (60,))
    d.polygon([(ccx - cr, ccy), (ccx, ccy - cr * 0.18), (ccx + cr, ccy), (ccx, ccy + cr * 0.18)], outline=INK + (200,))
    d.text((ccx - H * 0.012, ccy - cr - H * 0.05), "N", font=f_sub, fill=INK + (220,))
    img.save(os.path.join(out, f"f{k:04d}.png"))
print(f"{n} frames")
