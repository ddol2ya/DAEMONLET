"""Synthetic helper checks: no ComfyUI, network, model weights or character art."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts/characters/lib'))
from build_a import largest
from refine_base_face_a import holes
from assemble_finish_art import chroma_matte
from prepare import checked_root
sys.path.insert(0,str(ROOT/'scripts/characters'))
spec=importlib.util.spec_from_file_location('source_models',ROOT/'scripts/characters/build-source-models.py')
source_models=importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_models)

class CreatorTools(unittest.TestCase):
    def test_native_iris_mask_is_independent_of_rgb(self):
        core = np.ones((32, 32), bool)
        masks = []
        for color in [(40, 80, 220), (140, 55, 30), (50, 160, 55)]:
            native = np.zeros((32, 32, 4), dtype=np.uint8)
            native[10:20, 12:18, :3] = color
            native[10:20, 12:18, 3] = 255
            masks.append(source_models.select_iris_mask(native,core))
        self.assertEqual(int(masks[0].sum()), 60)
        for mask in masks[1:]: np.testing.assert_array_equal(mask, masks[0])

    def test_shared_matte_preserves_real_alpha_and_removes_green(self):
        rgba = np.zeros((12, 12, 4), dtype=np.uint8)
        rgba[3:9, 3:9] = [150, 90, 80, 128]
        np.testing.assert_array_equal(chroma_matte(Image.fromarray(rgba)), rgba)
        opaque = np.zeros((16, 16, 4), dtype=np.uint8)
        opaque[:] = [0, 255, 0, 255]
        opaque[4:12, 4:12] = [180, 90, 70, 255]
        result = chroma_matte(Image.fromarray(opaque))
        self.assertEqual(int(result[0, 0, 3]), 0)
        self.assertEqual(int(result[8, 8, 3]), 255)

    def test_png_bridge_preserves_every_channel(self):
        with tempfile.TemporaryDirectory(prefix='daemonlet-png-') as temp:
            file = str(Path(temp)/'roundtrip.png')
            raw = np.arange(7*9*4, dtype=np.uint8).tobytes()
            bridge = str(ROOT/'scripts/characters/png-rgba.py')
            subprocess.run([sys.executable, bridge, 'write', file, '7', '9'], input=raw, check=True)
            result = subprocess.check_output([sys.executable, bridge, 'read', file])
            self.assertEqual(result, raw)

    def test_production_modules_load_without_an_experiment_checkout(self):
        for name in ['build-source-models.py', 'finish-source-models.py']:
            subprocess.run([sys.executable, str(ROOT/'scripts/characters'/name), '--help'], stdout=subprocess.DEVNULL, check=True)
        self.assertEqual(checked_root(ROOT/'outputs/characters/new-run'), ROOT/'outputs/characters/new-run')
        with self.assertRaises(ValueError): checked_root(ROOT/'public/characters/gpichan')

if __name__ == '__main__': unittest.main()
