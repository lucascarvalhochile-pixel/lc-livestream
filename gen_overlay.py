#!/usr/bin/env python3
"""Generate transparent PNG overlay for LC LiveStream.
Usage: python3 gen_overlay.py <name> <destinations> <cta> <output_path> [logo_path]
"""
from PIL import Image, ImageDraw, ImageFont
import sys, os

name = sys.argv[1] if len(sys.argv) > 1 else "Lucas Carvalho"
destinations = sys.argv[2] if len(sys.argv) > 2 else ""
cta = sys.argv[3] if len(sys.argv) > 3 else "Clique no link abaixo e fale no WhatsApp"
output = sys.argv[4] if len(sys.argv) > 4 else "overlay.png"
logo_path = sys.argv[5] if len(sys.argv) > 5 else ""

W, H = 1080, 1920
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

DEEP_BLUE = (1, 0, 254)
SKY = (205, 217, 255)
WHITE = (255, 255, 255)

try:
    font_name = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 44)
    font_dest = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
    font_cta = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
except:
    font_name = ImageFont.load_default()
    font_dest = font_name
    font_cta = font_name

# Lower third position
lt_y = int(H * 0.66)
lt_height = int(H * 0.085)
lt_width = int(W * 0.75)

# Background bar with rounded corners
bar = Image.new('RGBA', (lt_width, lt_height), (0, 0, 0, 0))
bar_draw = ImageDraw.Draw(bar)
bar_draw.rounded_rectangle([0, 0, lt_width - 1, lt_height - 1], radius=16, fill=(10, 12, 20, 180))
# Deep Blue accent line
bar_draw.rectangle([0, 0, int(lt_width * 0.65), 4], fill=(*DEEP_BLUE, 230))
img.paste(bar, (int(W * 0.035), lt_y), bar)

# Name
nx = int(W * 0.055)
ny = lt_y + 16
draw.text((nx, ny), name, font=font_name, fill=(*WHITE, 255))

# Destinations
if destinations:
    draw.text((nx, ny + 52), destinations, font=font_dest, fill=(*SKY, 180))

# CTA pill
if cta:
    cta_y = lt_y + lt_height + 18
    bbox = draw.textbbox((0, 0), cta, font=font_cta)
    cw = bbox[2] - bbox[0] + 40
    ch = bbox[3] - bbox[1] + 18
    pill = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    pill_draw = ImageDraw.Draw(pill)
    pill_draw.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=12, fill=(255, 255, 255, 30))
    img.paste(pill, (nx - 8, cta_y - 4), pill)
    # WhatsApp green dot
    draw.ellipse([nx - 2, cta_y + 1, nx + 18, cta_y + 21], fill=(37, 211, 102, 220))
    draw.text((nx + 26, cta_y), cta, font=font_cta, fill=(*WHITE, 180))

# Logo
if logo_path and os.path.exists(logo_path):
    logo = Image.open(logo_path).convert('RGBA')
    lw = 180
    lh = int(logo.height * (lw / logo.width))
    logo = logo.resize((lw, lh), Image.LANCZOS)
    lx = W - lw - 40
    ly = int(H * 0.177)
    # Shadow
    shadow = Image.new('RGBA', (lw + 16, lh + 16), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([0, 0, lw + 15, lh + 15], radius=8, fill=(0, 0, 0, 50))
    img.paste(shadow, (lx - 8, ly - 8), shadow)
    img.paste(logo, (lx, ly), logo)

img.save(output)
print(f"OK: {output} ({os.path.getsize(output)} bytes)")
