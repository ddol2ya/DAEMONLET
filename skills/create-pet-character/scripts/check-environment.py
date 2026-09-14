"""Run with the user's ComfyUI Python, on the GPU host. Read-only; no installs."""
import argparse
import csv
import importlib.metadata
import json
import math
import re
import subprocess
import sys
from pathlib import Path


def positive_gib(value):
    capacity = float(value)
    if not math.isfinite(capacity) or capacity <= 0:
        raise ValueError('VRAM must be a positive finite GiB number')
    return capacity


def single_gpu_vram(gpu_csv):
    """nvidia-smi reports MiB; never guess which GPU ComfyUI uses on a multi-GPU host."""
    rows = list(csv.reader(gpu_csv.splitlines())) if gpu_csv else []
    if len(rows) != 1 or len(rows[0]) != 2:
        return None
    try:
        return positive_gib(rows[0][1]) / 1024
    except (TypeError, ValueError):
        return None


def build_report(comfy_root, vram_gib=None):
    root = Path(comfy_root).expanduser().resolve()
    errors = []
    for path in ['main.py', 'custom_nodes/ComfyUI-See-through/nodes.py']:
        if not (root / path).is_file():
            errors.append('Missing ' + path)
    dependencies = json.loads((Path(__file__).resolve().parent.parent / 'external-dependencies.json').read_text(encoding='utf-8'))
    versions = {}
    for package in ['torch', 'diffusers', 'accelerate']:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            errors.append('Missing Python package: ' + package)
    version = tuple(int(n) for n in re.findall('[0-9]+', versions.get('diffusers', '0.0.0'))[:3])
    minimum = dependencies['seeThrough']['diffusersMinimum']
    if version < tuple(int(n) for n in minimum.split('.')):
        errors.append('Supported See-through profile requires diffusers >= ' + minimum)
    try:
        gpu = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=15, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        gpu = None
        errors.append('Cannot query NVIDIA GPU; confirm the selected GPU environment')
    capacity = positive_gib(vram_gib) if vram_gib is not None else single_gpu_vram(gpu)
    group_offload = None
    if capacity is None:
        errors.append('Cannot determine the selected GPU total VRAM; pass --vram-gib with the capacity of the GPU used by ComfyUI')
    else:
        group_offload = capacity <= dependencies['profile']['groupOffload']['maximumVramGiB']
    try:
        from diffusers import DiffusionPipeline
        if group_offload and not hasattr(DiffusionPipeline, 'enable_group_offload'):
            errors.append('This diffusers runtime has no DiffusionPipeline.enable_group_offload')
    except Exception as exc:
        errors.append('Cannot load diffusers: ' + str(exc))
    license_entries = [{'id': name, **item.get('licenseEvidence', {'status': 'unverified'}), 'installedRevisionChecked': False}
                       for name, item in [('ComfyUI', dependencies['comfyui']), ('ComfyUI-See-through', dependencies['seeThrough'])]
                       + [(item['id'], item) for item in dependencies['models']]]
    next_step = ('Verify both loaders actually enable group offload in the first inference log.' if group_offload
                 else 'Verify both loaders use group_offload=false in the first inference log.' if group_offload is False
                 else 'Confirm the selected ComfyUI GPU capacity before running inference.')
    return {'comfyRoot': str(root), 'python': sys.executable, 'versions': versions,
            'technicalReadiness': 'not-ready' if errors else 'environment-ready',
            'licenseReview': {'status': 'pending', 'installedEnvironment': 'unverified', 'entries': license_entries, 'acknowledgementGrantsRights': False},
            'gpu': gpu, 'vramGiB': capacity, 'groupOffload': group_offload,
            'vramSource': 'explicit capacity' if vram_gib is not None else 'single NVIDIA GPU' if capacity is not None else 'unavailable',
            'errors': errors, 'inferenceRun': False, 'next': next_step}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--comfy-root', required=True)
    parser.add_argument('--vram-gib', type=positive_gib, help='Total VRAM of the GPU used by ComfyUI; required when automatic detection is ambiguous')
    args = parser.parse_args()
    report = build_report(args.comfy_root, args.vram_gib)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
