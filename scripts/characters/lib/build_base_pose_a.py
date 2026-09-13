"""Shared image operations for pose-local character production."""
import re
import numpy as np
from PIL import Image
from prepare import sha

def stem(n):
    return re.sub('[-_](?:[lr]|\\d+)$', '', n)

def box(mask):
    y, x = np.where(mask)
    assert len(x), 'Empty layer'
    return [int(x.min()), int(y.min()), int(x.max() + 1), int(y.max() + 1)]

def load_layers(folder, metadata, *, pose_local_sides=False):
    result = {}
    names = []
    mapping = []
    scale = 1280 / metadata['width']
    side_names = {}
    if pose_local_sides:
        paired = {}
        face = next((l for l in metadata['layers'] if l['name'] == 'face'), None)
        center = (face['left'] + face['right']) / 2 if face else metadata['width'] / 2
        for l in metadata['layers']:
            if re.search('-[lr]$', l['name']):
                paired.setdefault(stem(l['name']), []).append(l)
        for kind, layers in paired.items():
            assert len(layers) <= 2, 'Ambiguous pose-local side count: ' + kind
            layers = sorted(layers, key=lambda l: (l['left'] + l['right']) / 2)
            for index, l in enumerate(layers):
                left = index == 0 if len(layers) == 2 else (l['left'] + l['right']) / 2 < center
                side_names[l['name']] = kind + ('-l' if left else '-r')
    for l in metadata['layers']:
        f = (folder / l['filename']).resolve()
        assert f.is_relative_to(folder.resolve())
        im = Image.open(f).convert('RGBA')
        b = [round(l[k] * scale) for k in ['left', 'top', 'right', 'bottom']]
        full = Image.new('RGBA', (1280, 1280))
        full.paste(im.resize((b[2] - b[0], b[3] - b[1]), Image.Resampling.LANCZOS), b[:2])
        name = l['name']
        if re.search('-[lr]$', name):
            name = side_names[name] if pose_local_sides else stem(name) + ('-l' if (b[0] + b[2]) / 2 < 640 else '-r')
        if name == 'mouth':
            name = 'mouth_close'
        assert name not in result, 'Ambiguous native side'
        result[name] = np.array(full)
        names.append(name)
        mapping.append({'name': name, 'native_name': l['name'], 'file': l['filename'], 'sha256': sha(f)})
    return (result, names, mapping)

def compose(layers, names):
    c = np.zeros((1280, 1280, 3), float)
    alpha = np.zeros((1280, 1280))
    for n in names:
        ar = layers[n]
        a = ar[:, :, 3] / 255
        c = c * (1 - a[:, :, None]) + ar[:, :, :3] * a[:, :, None]
        alpha = alpha * (1 - a) + a
    return (c, alpha)

def visibility(layers, names):
    trans = np.ones((1280, 1280))
    weight = np.zeros_like(trans)
    owner = np.full(trans.shape, -1, int)
    for i in reversed(range(len(names))):
        a = layers[names[i]][:, :, 3] / 255
        v = a * trans
        trans *= 1 - a
        take = v > weight
        owner[take] = i
        weight[take] = v[take]
    return (owner, weight)
