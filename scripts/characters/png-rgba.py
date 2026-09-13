"""Lossless PNG/RGBA bridge; uses the same Pillow environment as the creator."""
import sys
from PIL import Image
if sys.argv[1] == 'read':
    sys.stdout.buffer.write(Image.open(sys.argv[2]).convert('RGBA').tobytes())
elif sys.argv[1] == 'write':
    width, height = map(int, sys.argv[3:5])
    data = sys.stdin.buffer.read()
    if len(data) != width * height * 4:
        raise ValueError('RGBA byte count does not match dimensions')
    Image.frombytes('RGBA', (width, height), data).save(sys.argv[2])
else:
    raise ValueError('Expected read or write')
