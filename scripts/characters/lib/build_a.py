"""Shared image operations for pose-local character production."""
from collections import deque
import numpy as np

def largest(mask):
    seen = np.zeros(mask.shape, bool)
    best = []
    h, w = mask.shape
    for y, x in np.argwhere(mask):
        if seen[y, x]:
            continue
        group = []
        q = deque([(y, x)])
        seen[y, x] = True
        while q:
            yy, xx = q.popleft()
            group.append((yy, xx))
            for dy, dx in [(0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)]:
                ny, nx = (yy + dy, xx + dx)
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and (not seen[ny, nx]):
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(group) > len(best):
            best = group
    result = np.zeros_like(mask)
    for y, x in best:
        result[y, x] = True
    return result
