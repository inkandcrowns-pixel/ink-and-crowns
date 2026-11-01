"""Thumbnail 1280x720: the lithograph, warm grade, dark side gradient, huge Anton text (2 lines, one word yellow),
thick black outline + shadow, thin red rule. Usage: python -I thumb.py <bg.jpg> <out.jpg> "<TEXT>" [side=left|right]"""
import os, sys
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

bg, out, text = sys.argv[1], sys.argv[2], sys.argv[3].upper()
side = sys.argv[4] if len(sys.argv) > 4 else "left"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1280, 720

img = Image.open(bg).convert("RGB")
s = max(W / img.width, H / img.height) * 1.1   # zoom 10%: crops the lithograph's paper border
img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
img = img.crop(((img.width - W) // 2, (img.height - H) // 2, (img.width - W) // 2 + W, (img.height - H) // 2 + H))
img = ImageEnhance.Contrast(ImageEnhance.Color(img).enhance(1.25)).enhance(1.12)

# dark gradient behind the text side
grad = Image.new("L", (W, H))
gd = ImageDraw.Draw(grad)
for x in range(W):
    f = x / W if side == "right" else 1 - x / W
    gd.line([(x, 0), (x, H)], fill=int(215 * max(0, f - 0.25) / 0.75))
img = Image.composite(Image.new("RGB", (W, H), (18, 10, 4)), img, grad)

# split text into 2 balanced lines, biggest font that fits ~58% width
words = text.split()
best = (words, [])
if len(words) > 1:
    cut = min(range(1, len(words)), key=lambda k: abs(len(" ".join(words[:k])) - len(" ".join(words[k:]))))
    best = (words[:cut], words[cut:])
lines = [" ".join(l) for l in best if l]
fp = os.path.join(ROOT, "fonts", "Anton-Regular.ttf")
size = 230
while size > 60:
    font = ImageFont.truetype(fp, size)
    if max(font.getlength(l) for l in lines) <= W * 0.58 and size * 1.05 * len(lines) <= H * 0.78:
        break
    size -= 6
lh = int(size * 1.02)
y0 = (H - lh * len(lines)) // 2
x0 = 60 if side == "left" else W - 60
d = ImageDraw.Draw(img)
shadow = Image.new("L", (W, H), 0)
sd = ImageDraw.Draw(shadow)
yellow_line = len(lines) - 1          # last line in yellow: the payoff word(s)
for i, l in enumerate(lines):
    tw = font.getlength(l)
    x = x0 if side == "left" else x0 - tw
    sd.text((x + 8, y0 + i * lh + 10), l, font=font, fill=200)
img.paste(Image.new("RGB", (W, H), (0, 0, 0)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(10)))
d = ImageDraw.Draw(img)
for i, l in enumerate(lines):
    tw = font.getlength(l)
    x = x0 if side == "left" else x0 - tw
    d.text((x, y0 + i * lh), l, font=font, fill=(255, 205, 40) if i == yellow_line else (255, 248, 235),
           stroke_width=max(6, size // 22), stroke_fill=(0, 0, 0))
rx = x0 if side == "left" else x0 - 220
ry = y0 + lh * len(lines) + int(size * 0.12)
d.rectangle([rx, ry, rx + 220, ry + 12], fill=(190, 30, 20))
img.save(out, quality=92)
print("thumb", out, size)
