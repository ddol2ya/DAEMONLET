"""Shared image operations for pose-local character production."""
import numpy as np
from PIL import Image, ImageFilter
from build_base_pose_a import visibility, compose
from split_sleeve_poses import morph
canon = lambda n: {'handwear-l': 'handwear_1', 'handwear-r': 'handwear_2'}.get(n, n.replace('eyewhite-', 'eyewhite_').replace('irides-', 'irides_').replace('eyelash-', 'eyelash_').replace('eyebrow-', 'eyebrow_').replace('eye_close-', 'eye_close_').replace('ears-l', 'ears_1').replace('ears-r', 'ears_2'))

def over(parts):
    im = Image.new('RGBA', (1280, 1280))
    for ar in parts:
        im = Image.alpha_composite(im, Image.fromarray(ar))
    return np.array(im)

def feather(mask, px=1):
    return np.array(Image.fromarray(np.rint(np.clip(mask, 0, 1) * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(px))) / 255

def correct_visible(parts, order, src, exclude):
    owner, weight = visibility(parts, order)
    _, al = compose(parts, order)
    subject = src[:, :, 3] / 255
    healed = {}
    for i, n in enumerate(order):
        use = (owner == i) & (subject > 0.94) & (weight > 0.03) & (al > 0.12) & ~exclude
        parts[n][use, 3] = 255
        healed[n] = int(use.sum())
    owner, weight = visibility(parts, order)
    _, al = compose(parts, order)
    missing = (subject > 0.94) & (al < 0.95) & ~exclude
    for radius in [3, 9, 21, 41]:
        if not missing.any():
            break
        best = np.zeros((1280, 1280))
        chosen = np.full((1280, 1280), -1)
        for i, n in enumerate(order):
            if n.startswith(('eye', 'irides', 'mouth', 'nose')):
                continue
            near = morph(parts[n][:, :, 3] / 255, radius)
            take = missing & (near > best)
            best[take] = near[take]
            chosen[take] = i
        for i, n in enumerate(order):
            use = missing & (chosen == i) & (best > 0.5)
            parts[n][use] = src[use]
        _, al = compose(parts, order)
        missing = (subject > 0.94) & (al < 0.95) & ~exclude
    col, al = compose(parts, order)
    owner, weight = visibility(parts, order)
    for i, n in enumerate(order):
        use = (owner == i) & (weight > 0.05) & (subject > 0.94) & ~exclude
        rgb = parts[n][:, :, :3].astype(float)
        rgb[use] = np.clip(rgb[use] + (src[:, :, :3].astype(float) - col)[use] / weight[use, None], 0, 255)
        parts[n][:, :, :3] = np.rint(rgb).astype('uint8')
    return healed
