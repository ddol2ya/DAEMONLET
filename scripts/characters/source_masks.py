"""Explicit pose-local masks; no color, character-coordinate or largest-skin assumptions."""
from pathlib import Path
from collections import deque
import numpy as np
from PIL import Image

def load_mask(pose_root, reference, shape):
    root=Path(pose_root).resolve();path=(root/reference).resolve()
    if not path.is_relative_to(root):raise ValueError('Mask must belong to this pose')
    with Image.open(path) as image:
        if image.size!=(shape[1],shape[0]):raise ValueError('Mask must match normalized source canvas')
        if image.mode not in ['1','L']:raise ValueError('Use an explicit grayscale mask: white selects, black excludes')
        mask=np.array(image.convert('L'),dtype=float)/255
    if not (mask>.5).any():raise ValueError('Empty reviewed mask')
    return mask

def component_at(mask, point):
    if len(point)!=2 or not all(np.isfinite(v) for v in point):raise ValueError('Face point needs finite x,y')
    x,y=map(lambda v:int(round(v)),point);h,w=mask.shape
    if not (0<=x<w and 0<=y<h and mask[y,x]):raise ValueError('Choose a point inside the actual face skin component')
    result=np.zeros(mask.shape,bool);result[y,x]=True;queue=deque([(y,x)])
    while queue:
        y,x=queue.popleft()
        for dy,dx in [(0,1),(0,-1),(1,0),(-1,0),(1,1),(1,-1),(-1,1),(-1,-1)]:
            ny,nx=y+dy,x+dx
            if 0<=ny<h and 0<=nx<w and mask[ny,nx] and not result[ny,nx]:
                result[ny,nx]=True;queue.append((ny,nx))
    return result
