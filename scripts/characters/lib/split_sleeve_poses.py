"""Shared image operations for pose-local character production."""
import numpy as np
from PIL import Image, ImageFilter

def morph(mask, k, op='max'):
    return np.array(Image.fromarray((np.clip(mask, 0, 1) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(k) if op == 'max' else ImageFilter.MinFilter(k))) / 255
