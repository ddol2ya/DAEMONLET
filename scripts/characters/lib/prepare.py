"""Explicit workspace paths and deterministic production metadata."""
from pathlib import Path
import hashlib, json, os
REPO = Path(__file__).resolve().parents[3]
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
def checked_root(value):
    root = Path(value).resolve()
    parent = (REPO/'outputs/characters').resolve()
    if not root.is_relative_to(parent) or root == parent:
        raise ValueError('Output must be a child of outputs/characters in the creator workspace')
    if root.exists():
        for file in root.rglob('*'):
            if file.is_symlink() and not file.resolve().is_relative_to(root):
                raise ValueError('Output symlink escaped the selected character run')
    os.environ.setdefault('DAEMONLET_CREATOR_PYTHON', __import__('sys').executable)
    return root
