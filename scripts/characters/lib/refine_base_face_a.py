"""Shared image operations for pose-local character production."""
from collections import deque
import numpy as np

def holes(mask):
    mask = mask.copy()
    seen = np.zeros_like(mask, bool)
    h, w = mask.shape
    q = deque()
    for y, x in [(y, x) for y in range(h) for x in [0, w - 1]] + [(y, x) for x in range(w) for y in [0, h - 1]]:
        if not mask[y, x] and (not seen[y, x]):
            seen[y, x] = True
            q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
            yy, xx = (y + dy, x + dx)
            if 0 <= yy < h and 0 <= xx < w and (not seen[yy, xx]) and (not mask[yy, xx]):
                seen[yy, xx] = True
                q.append((yy, xx))
    return ~seen
