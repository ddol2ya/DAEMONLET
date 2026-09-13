"""Run with the user's ComfyUI Python, on the GPU host. Read-only; no installs."""
import argparse
import importlib.metadata
import json
import re
import subprocess
import sys
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--comfy-root', required=True)
a = p.parse_args()
root = Path(a.comfy_root).expanduser().resolve()
errors = []
for path in ['main.py', 'custom_nodes/ComfyUI-See-through/nodes.py']:
    if not (root / path).is_file(): errors.append('Missing ' + path)
versions = {}
for package in ['torch', 'diffusers', 'accelerate']:
    try: versions[package] = importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError: errors.append('Missing Python package: ' + package)
version = tuple(int(n) for n in re.findall('[0-9]+', versions.get('diffusers', '0.0.0'))[:3])
if version < (0, 37, 0): errors.append('group offload requires diffusers >= 0.37.0')
try:
    from diffusers import DiffusionPipeline
    if not hasattr(DiffusionPipeline, 'enable_group_offload'):
        errors.append('This diffusers runtime has no DiffusionPipeline.enable_group_offload')
except Exception as exc:
    errors.append('Cannot load diffusers: ' + str(exc))
try:
    gpu = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'], capture_output=True, text=True, timeout=15, check=True).stdout.strip()
except (OSError, subprocess.SubprocessError):
    gpu = None
    errors.append('Cannot query NVIDIA GPU; confirm the selected GPU environment')
dependencies = json.loads((Path(__file__).resolve().parent.parent / 'external-dependencies.json').read_text(encoding='utf-8'))
license_entries = [{'id': name, **item.get('licenseEvidence', {'status': 'unverified'}), 'installedRevisionChecked': False}
                   for name, item in [('ComfyUI', dependencies['comfyui']), ('ComfyUI-See-through', dependencies['seeThrough'])]
                   + [(item['id'], item) for item in dependencies['models']]]
print(json.dumps({'comfyRoot': str(root), 'python': sys.executable, 'versions': versions,
                  'technicalReadiness': 'not-ready' if errors else 'environment-ready',
                  'licenseReview': {'status': 'pending', 'installedEnvironment': 'unverified', 'entries': license_entries, 'acknowledgementGrantsRights': False},
                  'gpu': gpu, 'errors': errors, 'inferenceRun': False,
                  'next': 'Verify both loaders actually enable group offload in the first inference log.'}, ensure_ascii=False, indent=2))
sys.exit(1 if errors else 0)
