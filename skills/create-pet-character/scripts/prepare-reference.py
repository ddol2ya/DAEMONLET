"""Normalize a selected reference, preserving its source and actual alpha."""
import argparse
import hashlib
import io
import json
from pathlib import Path
from PIL import Image, ImageCms, ImageOps

p = argparse.ArgumentParser()
p.add_argument('source', type=Path)
p.add_argument('output', type=Path)
a = p.parse_args()
data = a.source.read_bytes()
with Image.open(io.BytesIO(data)) as original:
    im = ImageOps.exif_transpose(original)
    rgba = im.convert('RGBA')
    if im.info.get('icc_profile'):
        alpha = rgba.getchannel('A')
        rgba = ImageCms.profileToProfile(rgba, ImageCms.ImageCmsProfile(io.BytesIO(im.info['icc_profile'])), ImageCms.createProfile('sRGB'), outputMode='RGBA')
        rgba.putalpha(alpha)
    scale = 1280 / max(rgba.size)
    size = tuple(max(1, round(n * scale)) for n in rgba.size)
    offset = tuple((1280 - n) // 2 for n in size)
    canvas = Image.new('RGBA', (1280, 1280))
    canvas.paste(rgba.resize(size, Image.Resampling.LANCZOS), offset)
    # Fail if the destination exists; never mutate the user's selected source.
    a.output.mkdir(parents=True, exist_ok=False)
    (a.output / ('source-original' + a.source.suffix)).write_bytes(data)
    canvas.save(a.output / 'master.png')
    record = {'sourceSha256': hashlib.sha256(data).hexdigest(), 'sourceSize': list(rgba.size),
              'canvas': [1280, 1280], 'scaledSize': list(size), 'offset': list(offset),
              'sourceToMaster': [size[0]/rgba.width, 0, offset[0], 0, size[1]/rgba.height, offset[1]],
              'sourceHasTransparentPixels': rgba.getchannel('A').getextrema()[0] < 255,
              'masterSha256': hashlib.sha256((a.output/'master.png').read_bytes()).hexdigest(),
              'backgroundRemoved': False}
    (a.output / 'normalization.json').write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(record, indent=2))
