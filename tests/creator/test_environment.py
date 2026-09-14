"""Synthetic VRAM/environment checks; no GPU, model imports or network calls."""
import importlib.util
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('creator_environment', ROOT/'skills/create-pet-character/scripts/check-environment.py')
environment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(environment)


class EnvironmentChecks(unittest.TestCase):
    def report(self, gpu_csv, capacity=None, supports_offload=True):
        with tempfile.TemporaryDirectory(prefix='daemonlet-environment-') as temp:
            root = Path(temp)
            (root/'custom_nodes/ComfyUI-See-through').mkdir(parents=True)
            (root/'main.py').touch()
            (root/'custom_nodes/ComfyUI-See-through/nodes.py').touch()
            diffusers = types.ModuleType('diffusers')
            diffusers.DiffusionPipeline = type('DiffusionPipeline', (), {'enable_group_offload': lambda: None} if supports_offload else {})
            with patch.dict(sys.modules, {'diffusers': diffusers}), \
                 patch.object(environment.importlib.metadata, 'version', return_value='0.37.0'), \
                 patch.object(environment.subprocess, 'run', return_value=types.SimpleNamespace(stdout=gpu_csv)) as query:
                result = environment.build_report(root, capacity)
                self.assertIn('--query-gpu=name,memory.total', query.call_args.args[0])
                self.assertFalse(result['inferenceRun'])
                self.assertEqual(result['licenseReview']['status'], 'pending')
                return result

    def test_capacity_boundary_selects_both_modes(self):
        for mib, enabled in [(8192, True), (12288, True), (12289, False), (16384, False), (24576, False)]:
            with self.subTest(mib=mib):
                result = self.report(f'Synthetic GPU, {mib}')
                self.assertEqual(result['technicalReadiness'], 'environment-ready')
                self.assertEqual(result['vramGiB'], mib/1024)
                self.assertEqual(result['groupOffload'], enabled)
                self.assertIn('enable group offload' if enabled else 'group_offload=false', result['next'])

    def test_offload_api_is_only_required_when_selected(self):
        low = self.report('Synthetic GPU, 12288', supports_offload=False)
        high = self.report('Synthetic GPU, 24576', supports_offload=False)
        self.assertEqual(low['technicalReadiness'], 'not-ready')
        self.assertIn('enable_group_offload', ' '.join(low['errors']))
        self.assertEqual(high['technicalReadiness'], 'environment-ready')

    def test_unknown_or_multiple_gpu_capacity_requires_an_explicit_value(self):
        for csv in ['', 'Synthetic GPU, N/A', 'Synthetic GPU, 0', 'Synthetic GPU, nan', 'Synthetic GPU, inf', 'Synthetic GPU A, 8192\nSynthetic GPU B, 24576']:
            with self.subTest(csv=csv):
                result = self.report(csv)
                self.assertEqual(result['technicalReadiness'], 'not-ready')
                self.assertIsNone(result['groupOffload'])
                self.assertIn('--vram-gib', ' '.join(result['errors']))
        for capacity, enabled in [(12, True), (24, False)]:
            result = self.report('Synthetic GPU A, 8192\nSynthetic GPU B, 24576', capacity)
            self.assertEqual(result['technicalReadiness'], 'environment-ready')
            self.assertEqual(result['groupOffload'], enabled)
            self.assertEqual(result['vramSource'], 'explicit capacity')

    def test_invalid_explicit_capacity_is_rejected(self):
        for value in [0, -1, 'nan', 'inf', 'invalid']:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    environment.positive_gib(value)


if __name__ == '__main__':
    unittest.main()
