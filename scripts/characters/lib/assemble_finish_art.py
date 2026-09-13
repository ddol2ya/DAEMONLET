"""Shared image operations for pose-local character production."""
import numpy as np
from PIL import Image, ImageDraw

def chroma_matte(image):
    """Recover antialiased RGBA from the explicitly requested uniform green matte."""
    pixels = np.array(image.convert('RGBA'))
    rgb = pixels[:, :, :3].astype(float)
    if pixels[:, :, 3].min() < 250:
        return pixels
    rb = np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    key = (rgb[:, :, 1] - rb > 80) & (rb < 60)
    solid = (rgb[:, :, 1] <= rb + 1) & ~key
    colors = rgb.copy()
    valid = solid.copy()
    for _ in range(16):
        total = np.zeros_like(colors)
        count = np.zeros(valid.shape)
        for dy, dx in [(0, -1), (0, 1), (-1, 0), (1, 0), (-1, -1), (-1, 1), (1, -1), (1, 1)]:
            take = np.roll(valid, (dy, dx), (0, 1))
            shifted = np.roll(colors, (dy, dx), (0, 1))
            if dy < 0:
                take[dy:] = False
            if dy > 0:
                take[:dy] = False
            if dx < 0:
                take[:, dx:] = False
            if dx > 0:
                take[:, :dx] = False
            total += shifted * take[:, :, None]
            count += take
        fill = ~valid & (count > 0)
        colors[fill] = total[fill] / count[fill, None]
        valid[fill] = True
    background = np.array([0.0, 255.0, 0.0])
    delta = colors - background
    alpha = np.divide(((rgb - background) * delta).sum(2), (delta * delta).sum(2), out=np.zeros(valid.shape), where=(delta * delta).sum(2) > 1)
    alpha = np.clip(alpha, 0, 1)
    alpha[solid] = 1
    alpha[key | ~valid | (alpha < 0.025)] = 0
    foreground = colors.copy()
    foreground[solid] = rgb[solid]
    foreground[alpha < 0.015] = colors[alpha < 0.015]
    return np.dstack([np.rint(foreground).astype('uint8'), np.rint(alpha * 255).astype('uint8')])

def bounds(mask):
    yy, xx = np.nonzero(mask)
    if not len(xx):
        raise ValueError('Empty generated sprite')
    return [int(xx.min()), int(yy.min()), int(xx.max() + 1), int(yy.max() + 1)]

def contour_rows(alpha):
    left, right, good = ([], [], [])
    for y, row in enumerate(alpha.astype(float) / 255):
        xs = np.flatnonzero(row > 0.5)
        if not len(xs):
            left.append(0.0)
            right.append(0.0)
            continue
        a, b = (int(xs[0]), int(xs[-1]))
        good.append(y)
        av = row[a - 1] if a else 0.0
        bv = row[b + 1] if b + 1 < len(row) else 0.0
        left.append(a - 1 + (0.5 - av) / max(0.001, row[a] - av))
        right.append(b + (row[b] - 0.5) / max(0.001, row[b] - bv))
    yy = np.arange(len(alpha))
    l = np.interp(yy, good, np.array(left)[good])
    r = np.interp(yy, good, np.array(right)[good])
    kernel = np.array([1.0, 4.0, 6.0, 4.0, 1.0]) / 16
    return (np.convolve(np.pad(l, (2, 2), mode='edge'), kernel, 'valid'), np.convolve(np.pad(r, (2, 2), mode='edge'), kernel, 'valid'), good[0], good[-1])

def match_face_contour(generated, original):
    """Register generated jaw paint to the original silhouette, row by row."""
    a = np.array(generated)
    own = np.array(original)
    h, w = a.shape[:2]
    left, right, y0, y1 = contour_rows(own[:, :, 3])
    gl, gr, _, _ = contour_rows(a[:, :, 3])
    yy, xx = np.indices((h, w))
    t = (xx - left[:, None]) / np.maximum(1, right - left)[:, None]
    gx = np.clip(gl[:, None] + t * (gr - gl)[:, None], 0, w - 1)
    x0 = np.floor(gx).astype(int)
    x1 = np.minimum(w - 1, x0 + 1)
    f = gx - x0
    rgb = a[yy, x0, :3] * (1 - f[:, :, None]) + a[yy, x1, :3] * f[:, :, None]
    scale = 8
    mask = Image.new('L', (w * scale, h * scale))
    draw = ImageDraw.Draw(mask)
    polygon = [((left[y] + 0.5) * scale, (y + 0.5) * scale) for y in range(y0, y1 + 1)] + [((right[y] + 0.5) * scale, (y + 0.5) * scale) for y in range(y1, y0 - 1, -1)]
    draw.polygon(polygon, fill=255)
    alpha = np.array(mask.resize((w, h), Image.Resampling.LANCZOS))
    return Image.fromarray(np.dstack([np.rint(rgb).astype('uint8'), alpha]))

def smooth_field(values, sigma):
    h, w = values.shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    return np.fft.irfft2(np.fft.rfft2(values) * np.exp(-2 * np.pi * np.pi * sigma * sigma * (fx * fx + fy * fy)), s=values.shape).real

def despill_edges(image):
    pixels = np.array(image)
    rgb = pixels[:, :, :3].astype(float)
    alpha = pixels[:, :, 3] / 255
    bad = (rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2]) > 10) & (alpha > 0.015)
    if not bad.any():
        return (image, 0)
    weight = (alpha > 0.7) & ~bad
    blurred = smooth_field(weight.astype(float), 3)
    for channel in range(3):
        colour = np.divide(smooth_field(rgb[:, :, channel] * weight, 3), blurred, out=rgb[:, :, channel].copy(), where=blurred > 1e-06)
        pixels[bad, channel] = np.rint(np.clip(colour[bad], 0, 255)).astype('uint8')
    return (Image.fromarray(pixels), int(bad.sum()))
