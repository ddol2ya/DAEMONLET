"""CPU-only app-local admission fixtures. No executable/DLL/model is loaded."""
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

VOICE = Path(__file__).resolve().parents[1] / 'electron/voice'
sys.path.insert(0, str(VOICE))
import managed_gguf_runtime as managed


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def record(raw):
    return dict(bytes=len(raw), sha256=digest(raw))


class ManagedAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name).resolve()
        self.app = self.root/'app'; self.app.mkdir()
        self.install = self.root/'installed'; self.install.mkdir()
        self.components = {}
        self.payloads = {}
        for identity in ('shared','cuda-redist','qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan'):
            if identity == 'shared':
                payload = {'python/python.exe':b'pinned Python fixture (never executed)',
                           'python/python311.dll':b'Python DLL fixture', 'python/Lib/site-packages/empty/py.typed':b'',
                           'python/Lib/site-packages/empty/__init__.py':b'', 'vc/vcruntime140.dll':b'VC fixture'}
            elif identity == 'cuda-redist':
                payload = {'cuda/cudart64_13.dll':b'CUDA fixture (never loaded)'}
            else:
                payload = {'native/pinned.dll':identity.encode(),
                           'meta/native-build.json':json.dumps(dict(backend=identity)).encode()}
            self.payloads[identity] = payload
            self.components[identity] = dict(id=identity, archive=dict(name=identity+'.zip', format='zip',
                bytes=123, sha256=digest(identity.encode())), files={name:record(raw) for name,raw in payload.items()},
                provenance={'fixtureOnly':True})
        self.runtimes = {}
        for identity in ('qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan'):
            cuda = identity.endswith('cuda')
            self.runtimes[identity] = dict(id=identity, engine='voxcpm2' if identity.startswith('vox') else 'qwen3-tts-06b-gguf',
                backend='CUDA0' if cuda else 'Vulkan0', components=['shared',*(['cuda-redist'] if cuda else []),identity],
                python=dict(component='shared',path='python/python.exe'), native=dict(component=identity,path='native'),
                dependencyDirs=[dict(component='shared',path='vc'),*([dict(component='cuda-redist',path='cuda')] if cuda else [])],
                pythonVersion='3.11.15')
            if identity.startswith('vox'):
                self.runtimes[identity]['receipt'] = dict(component=identity,path='meta/native-build.json')
        self.catalog = dict(schemaVersion=1,platform='win32-x64',components=self.components,runtimes=self.runtimes)
        self.layout = None
        self.active = 'qwen-cuda'; self.refresh_catalog(); self.install_selected()

    def tearDown(self):
        self.scratch.cleanup()

    def path(self, identity):
        fingerprint=self.components[identity]['archive']['sha256']
        return (self.install/'c'/identity/fingerprint[:12] if self.layout == 'compact-v1'
                else self.install/'components'/identity/fingerprint)

    def component_receipt(self, identity):
        return self.install/'component-receipts'/(identity+'-'+self.components[identity]['archive']['sha256']+'.json')

    def compact(self):
        self.layout='compact-v1';self.install=self.root/'compact-installed';self.install.mkdir()
        self.install_selected()

    def refresh_catalog(self):
        raw = json.dumps(self.catalog).encode()
        self.catalog_file = self.app/managed.CATALOG_NAME; self.catalog_file.write_bytes(raw)
        self.policy = dict(managedRuntimeCatalog=dict(filename=managed.CATALOG_NAME,**record(raw)))

    def install_selected(self):
        runtime = self.runtimes[self.active]
        for identity in runtime['components']:
            for name,raw in self.payloads[identity].items():
                path = self.path(identity)/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(raw)
        self.receipt = self.install/'runtimes'/ (self.active+'.json'); self.receipt.parent.mkdir(exist_ok=True)
        self.receipt_value = dict(schemaVersion=1,owner=managed.OWNER,id=self.active,
                catalogSha256=digest(self.catalog_file.read_bytes()),components=[dict(id=name,fingerprint=self.components[name]['archive']['sha256']) for name in runtime['components']])
        if self.layout == 'compact-v1':
            self.receipt_value.update(schemaVersion=2,layout=self.layout)
            self.marker=self.install/'.catalog.json'
            self.marker_value=dict(schemaVersion=1,owner='daemonlet-managed-gguf-runtime-catalog',
                                  catalogSha256=digest(self.catalog_file.read_bytes()),layout=self.layout)
            self.marker.write_text(json.dumps(self.marker_value))
            for identity in runtime['components']:
                path=self.component_receipt(identity);path.parent.mkdir(exist_ok=True)
                path.write_text(json.dumps(dict(schemaVersion=1,owner='daemonlet-managed-gguf-runtime-component',
                    id=identity,fingerprint=self.components[identity]['archive']['sha256'],
                    provenance=self.components[identity]['provenance'])))
        self.receipt.write_text(json.dumps(self.receipt_value))
        self.config = dict(root=str(self.install),receipt=str(self.receipt),runtimeId=self.active)

    def admit(self, **overrides):
        native = overrides.pop('native_dir',self.path(self.active)/'native')
        native_receipt = overrides.pop('native_receipt',self.path(self.active)/'meta/native-build.json' if self.active.startswith('vox') else None)
        with patch.object(managed,'__file__',str(self.app/'managed_gguf_runtime.py')), \
                patch.object(managed.sys,'platform','win32'), \
                patch.object(managed.platform,'machine',return_value='AMD64'), \
                patch.object(managed.platform,'python_version',return_value=overrides.pop('version','3.11.15')), \
                patch.object(managed.sys,'executable',str(overrides.pop('python',self.path('shared')/'python/python.exe'))):
            return managed.admit(overrides.pop('configuration',self.config),overrides.pop('policy',self.policy),
                                 overrides.pop('runtime_id',self.active),native,native_receipt)

    def rejected(self, **overrides):
        with self.assertRaisesRegex(ValueError,managed.ERROR):
            self.admit(**overrides)

    def test_manual_without_marker_preserves_old_policy(self):
        self.assertIsNone(managed.admit(None,{},'qwen-cuda',Path('manual')))

    def test_all_four_selected_routes_allow_missing_other_backends(self):
        for identity in self.runtimes:
            with self.subTest(identity=identity):
                self.active=identity;self.install_selected();value=self.admit()
                self.assertTrue(value['verified'])
                self.assertEqual(value['runtimeId'],identity)
                self.assertEqual(value['native'],self.path(identity)/'native')
                self.assertEqual(len(value['dependencyDirs']),2 if identity.endswith('cuda') else 1)

    def test_zero_byte_python_markers_are_pinned_and_allowed(self):
        value=self.admit()
        self.assertTrue(value['verified'])
        managed.full_hash(self.path('shared')/'python/Lib/site-packages/empty/py.typed',record(b''))

    def test_modified_vendor_bytes_fail_even_with_matching_receipt(self):
        (self.path('cuda-redist')/'cuda/cudart64_13.dll').write_bytes(b'foreign CUDA')
        self.rejected()

    def test_extra_shared_file_directory_dll_and_missing_file_fail(self):
        for name,directory in [('python/unknown.py',False),('vc/foreign.dll',False),('unexpected',True)]:
            with self.subTest(name=name):
                extra=self.path('shared')/name
                if directory:extra.mkdir()
                else:extra.write_bytes(b'unreviewed')
                self.rejected()
                if directory:extra.rmdir()
                else:extra.unlink()
        (self.path('shared')/'python/python311.dll').unlink();self.rejected()

    def test_flag_and_external_receipt_cannot_admit_unpinned_catalog(self):
        self.rejected(policy={})
        for change in [('owner','other'),('schemaVersion',True),('id','qwen-vulkan'),('catalogSha256','f'*64)]:
            self.receipt.write_text(json.dumps(dict(self.receipt_value,**{change[0]:change[1]})))
            self.rejected()

    def test_wrong_python_version_or_executable_or_native_path_fail(self):
        self.rejected(version='3.11.14')
        other=self.root/'other-python.exe';other.write_bytes(b'foreign interpreter')
        self.rejected(python=other)
        other_dir=self.root/'other-native';other_dir.mkdir()
        self.rejected(native_dir=other_dir)
        self.rejected(runtime_id='qwen-vulkan')

    def test_local_catalog_change_cannot_update_app_pin(self):
        self.catalog_file.write_text(json.dumps(dict(self.catalog,platform='win32-arm64')))
        self.rejected()

    def test_duplicate_receipt_keys_and_extra_keys_are_rejected(self):
        self.receipt.write_text('{"schemaVersion":1,"schemaVersion":1}')
        self.rejected()
        self.receipt.write_text(json.dumps(dict(self.receipt_value,trusted=True)))
        self.rejected()

    def test_selected_component_missing_and_wrong_fingerprint_fail(self):
        old=self.path('cuda-redist');old.rename(old.with_name('unapproved-fingerprint'))
        self.rejected()

    def test_case_alias_and_traversal_in_pinned_catalog_fail(self):
        for extra in ('../outside.dll','Native/pinned.dll','C:/absolute.dll','con.dll'):
            with self.subTest(extra=extra):
                original=self.components['qwen-cuda']['files'].copy()
                self.components['qwen-cuda']['files'][extra]=record(b'X');self.refresh_catalog();self.install_selected()
                self.rejected()
                self.components['qwen-cuda']['files']=original

    def test_symlink_and_hardlinked_component_payload_are_rejected(self):
        target=self.path('shared')/'vc/vcruntime140.dll'; original=target.read_bytes();target.unlink()
        outside=self.root/'outside.dll';outside.write_bytes(original)
        try:target.symlink_to(outside)
        except OSError:pass  # Windows may withhold symlink creation privileges.
        else:self.rejected();target.unlink()
        os.link(outside,target);self.rejected()

    def test_vulkan_disallows_cuda_dependency_and_cpu_backend(self):
        self.active='qwen-vulkan';self.install_selected()
        self.runtimes[self.active]['backend']='CPU';self.refresh_catalog();self.install_selected();self.rejected()
        self.runtimes[self.active]['backend']='Vulkan0'
        self.runtimes[self.active]['dependencyDirs'].append(dict(component='cuda-redist',path='cuda'))
        self.refresh_catalog();self.install_selected();self.rejected()

    def test_vox_native_build_receipt_must_be_catalog_bound(self):
        self.active='vox-cuda';self.install_selected();self.admit()
        other=self.root/'foreign-build-receipt.json';other.write_bytes(b'{}')
        self.rejected(native_receipt=other)

    def test_portable_native_path_uses_only_verified_dirs_and_os_system(self):
        value=self.admit()
        fixture_system=self.root/'owned-fixture-system'
        with patch.object(managed,'system_directory',return_value=fixture_system):
            paths=managed.managed_path(value).split(os.pathsep)
        self.assertEqual(paths,[str(value['native']),*(str(item) for item in value['dependencyDirs']),str(fixture_system)])
        self.assertNotIn('untrusted inherited PATH',paths)

    def test_receipt_outside_owned_root_is_rejected(self):
        external=self.root/'copied-receipt.json';external.write_bytes(self.receipt.read_bytes())
        self.rejected(configuration=dict(self.config,receipt=str(external)))

    def test_compact_all_four_routes_keep_legacy_files_and_full_identity(self):
        old_python=self.path('shared')/'python/python.exe';old_bytes=old_python.read_bytes()
        self.admit();self.compact()
        for identity in self.runtimes:
            with self.subTest(runtime=identity):
                self.active=identity;self.install_selected();value=self.admit()
                self.assertEqual(value['layout'],'compact-v1')
                self.assertTrue(value['verified'])
                for name,path in value['components'].items():
                    self.assertEqual(path,self.install/'c'/name/self.components[name]['archive']['sha256'][:12])
                self.assertEqual(self.receipt_value['components'],[
                    dict(id=name,fingerprint=self.components[name]['archive']['sha256'])
                    for name in self.runtimes[identity]['components']])
        self.assertEqual(old_python.read_bytes(),old_bytes)

    def test_compact_catalog_marker_missing_wrong_sha_shape_or_layout_fails(self):
        self.compact();original=self.marker.read_bytes();self.marker.unlink();self.rejected()
        for changes in [dict(catalogSha256='f'*64),dict(owner='foreign'),dict(schemaVersion=True),
                        dict(layout='compact-v2'),dict(extra=True)]:
            with self.subTest(changes=changes):
                self.marker.write_text(json.dumps(dict(self.marker_value,**changes)));self.rejected()
        self.marker.write_bytes(original);self.admit()

    def test_compact_active_receipt_requires_exact_schema_layout_and_full_fingerprints(self):
        self.compact()
        bad_values=[dict(self.receipt_value,layout='unknown'),dict(self.receipt_value,schemaVersion=1),
                    dict(self.receipt_value,schemaVersion=True),dict(self.receipt_value,extra=True),
                    dict(self.receipt_value,catalogSha256='f'*64),
                    {key:value for key,value in self.receipt_value.items() if key!='layout'},
                    dict(self.receipt_value,components=[dict(id='shared',fingerprint=self.components['shared']['archive']['sha256'][:12])])]
        for value in bad_values:
            with self.subTest(value=value):
                self.receipt.write_text(json.dumps(value));self.rejected()
        self.receipt.write_text(json.dumps(self.receipt_value));self.admit()

    def test_compact_component_ownership_receipt_is_required_and_exact(self):
        self.compact();path=self.component_receipt('shared');original=path.read_bytes();value=json.loads(original)
        path.unlink();self.rejected()
        for changes in [dict(owner='foreign'),dict(schemaVersion=True),dict(id='cuda-redist'),
                        dict(fingerprint='f'*64),dict(provenance={'spoofed':True}),dict(extra=True)]:
            with self.subTest(changes=changes):
                path.write_text(json.dumps(dict(value,**changes)));self.rejected()
        path.write_bytes(original);self.admit()

    def test_compact_prefix_collision_cannot_reuse_other_full_fingerprint(self):
        self.compact();identity='qwen-cuda';old_receipt=self.component_receipt(identity)
        old_sha=self.components[identity]['archive']['sha256'];new_sha=old_sha[:12]+'f'*52
        self.assertNotEqual(old_sha,new_sha)
        self.components[identity]['archive']['sha256']=new_sha;self.refresh_catalog()
        self.receipt_value['catalogSha256']=digest(self.catalog_file.read_bytes())
        for row in self.receipt_value['components']:
            if row['id']==identity:row['fingerprint']=new_sha
        self.receipt.write_text(json.dumps(self.receipt_value))
        self.marker_value['catalogSha256']=self.receipt_value['catalogSha256']
        self.marker.write_text(json.dumps(self.marker_value))
        self.rejected()  # Matching 12-character path is insufficient.
        old_receipt.rename(self.component_receipt(identity))
        self.rejected()  # Renaming an ownership record cannot change its full identity.

    def test_compact_payload_full_sha_and_extra_file_checks_remain_required(self):
        self.compact();target=self.path('shared')/'python/python311.dll';original=target.read_bytes()
        target.write_bytes(b'changed pinned DLL');self.rejected();target.write_bytes(original)
        extra=self.path(self.active)/'native/unapproved.dll';extra.write_bytes(b'foreign')
        self.rejected();extra.unlink();self.admit()

    def test_compact_marker_component_and_active_receipts_are_reread_after_hashing(self):
        self.compact();verify=managed.verify_component
        for target in (self.marker,self.component_receipt('shared'),self.receipt):
            with self.subTest(target=target):
                original=target.read_bytes();changed=False
                def mutate_after_hash(root,component,layout=None):
                    nonlocal changed
                    result=verify(root,component,layout)
                    if not changed:target.write_bytes(b' '+original);changed=True
                    return result
                with patch.object(managed,'verify_component',side_effect=mutate_after_hash):self.rejected()
                target.write_bytes(original)
        self.admit()

    def test_portable_qwen_requires_admitted_interpreter_and_exact_versions(self):
        import qwen_gguf_worker as qwen
        value = self.admit()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(qwen.sys,'platform','win32'))
            stack.enter_context(patch.object(qwen.platform,'machine',return_value='AMD64'))
            stack.enter_context(patch.object(qwen.platform,'python_version',return_value=qwen.POLICY['python']))
            stack.enter_context(patch.object(qwen.sys,'prefix','portable'))
            stack.enter_context(patch.object(qwen.sys,'base_prefix','portable'))
            stack.enter_context(patch.object(qwen.sys,'executable',str(value['python'])))
            versions = stack.enter_context(patch.object(qwen.metadata,'version',side_effect=qwen.POLICY['dependencies'].__getitem__))
            qwen.verify_environment(value)
            with self.assertRaisesRegex(ValueError,'QWEN_GGUF_RUNTIME_VERSION'):
                qwen.verify_environment(None)
            with self.assertRaisesRegex(ValueError,'QWEN_GGUF_RUNTIME_VERSION'):
                qwen.verify_environment(dict(value,verified=False))
            with patch.object(qwen.sys,'executable',str(self.root/'other-python.exe')):
                with self.assertRaisesRegex(ValueError,'QWEN_GGUF_RUNTIME_VERSION'):
                    qwen.verify_environment(value)
            versions.side_effect=None;versions.return_value='unapproved-version'
            with self.assertRaisesRegex(ValueError,'QWEN_GGUF_RUNTIME_VERSION'):
                qwen.verify_environment(value)

    def test_vox_managed_vendor_path_needs_no_toolkit_but_manual_route_does(self):
        import voxcpm_windows_gguf_worker as vox
        self.active='vox-cuda';self.install_selected();admitted=self.admit()
        assets=dict(managedRuntime=admitted, selected={}, modelKind='public-base', referenceCacheBuilds=0,
            conditioningFingerprint=None, reference=None, backend='CUDA', runtime=admitted['native'],
            binary=admitted['native']/'fixture.exe',base='fixture-base.gguf',acoustic='fixture-acoustic.gguf')
        request=dict(cache=str(self.root/'cache'),executionProfile='gguf-cuda-f16',runtimeSessionId='fixture-session')
        class LaunchIntercepted(Exception):pass
        with patch.object(vox,'validate',return_value=assets), \
                patch.object(vox,'verify_gpu_support',return_value={}) as driver, \
                patch.object(managed,'system_directory',return_value=self.root), \
                patch.dict(os.environ,CUDA_PATH=str(self.root/'absent-toolkit'),PATH='foreign-search-path'), \
                patch.object(vox.subprocess,'CREATE_NO_WINDOW',0,create=True), \
                patch.object(vox.subprocess,'Popen',side_effect=LaunchIntercepted) as launcher:
            with self.assertRaises(LaunchIntercepted):vox.WindowsGgufWorker().initialize(request)
            environment=launcher.call_args.kwargs['env']
            self.assertEqual(environment['PATH'],os.pathsep.join(map(str,[admitted['native'],*admitted['dependencyDirs'],self.root])))
            self.assertNotIn('CUDA_PATH',environment)
            driver.assert_called_once_with(admitted)
            launcher.reset_mock();assets['managedRuntime']=None
            with self.assertRaisesRegex(ValueError,'RUNTIME_DEPENDENCY'):
                vox.WindowsGgufWorker().initialize(request)
            launcher.assert_not_called()


class FakeFunction:
    def __init__(self, callback):self.callback=callback
    def __call__(self,*args):return self.callback(*args)


class FakeDriver:
    def __init__(self,version=13000,capability=(8,9),name=b'Fixture Ada GPU',init=0,device_status=0):
        def integer(pointer,value):
            ctypes.cast(pointer,ctypes.POINTER(ctypes.c_int))[0]=value
        def driver_version(pointer):integer(pointer,version);return 0
        def device(pointer,ordinal):integer(pointer,0);return device_status if ordinal==0 else 1
        def compute(major,minor,device):integer(major,capability[0]);integer(minor,capability[1]);return 0
        def device_name(buffer,size,device):buffer.value=name[:size-1];return 0
        self.cuInit=FakeFunction(lambda flags:init)
        self.cuDriverGetVersion=FakeFunction(driver_version)
        self.cuDeviceGet=FakeFunction(device)
        self.cuDeviceComputeCapability=FakeFunction(compute)
        self.cuDeviceGetName=FakeFunction(device_name)


class ManagedGpuGateTests(unittest.TestCase):
    """Fake driver only: these tests never load nvcuda or initialize a GPU."""
    def setUp(self):
        self.scratch=tempfile.TemporaryDirectory();self.system=Path(self.scratch.name).resolve()
        (self.system/'nvcuda.dll').write_bytes(b'CPU fixture, never loaded')
        self.admitted=dict(verified=True,runtimeId='qwen-cuda',backend='CUDA0',support=dict(
            cudaComputeCapabilities=[[8,9]],minimumCudaDriverApi=13000,minimumDriverBranch=580,
            validatedGpuNames=['NVIDIA RTX4090'],validationScope='private-RTX4090-candidate'))
    def tearDown(self):self.scratch.cleanup()
    def query(self,driver):
        with patch.object(managed,'system_directory',return_value=self.system), \
                patch.object(managed.ctypes,'WinDLL',return_value=driver,create=True) as loader:
            result=managed.verify_gpu_support(self.admitted)
            loader.assert_called_once_with(str(self.system/'nvcuda.dll'),winmode=0x800)
            return result
    def test_cuda_query_reports_actual_name_without_claiming_branch_check(self):
        value=self.query(FakeDriver(version=13020))
        self.assertEqual(value['cudaDriverApiVersion'],13020)
        self.assertEqual(value['cudaComputeCapability'],[8,9])
        self.assertEqual(value['cudaDeviceName'],'Fixture Ada GPU')
        self.assertEqual(value['cudaDeviceOrdinal'],0)
        self.assertFalse(value['driverBranchIndependentlyVerified'])
    def test_driver_api_older_than_pinned_binary_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'GGUF_MANAGED_DRIVER_UNSUPPORTED'):
            self.query(FakeDriver(version=12090))
    def test_other_gpu_generations_pass_preflight_for_both_cuda_workers(self):
        for runtime in ('qwen-cuda','vox-cuda'):
            self.admitted['runtimeId']=runtime
            for capability in ((7,5),(8,6),(8,9),(12,0),(13,0)):
                with self.subTest(runtime=runtime,capability=capability):
                    value=self.query(FakeDriver(capability=capability,name=b'Unlisted GPU'))
                    self.assertEqual(value['cudaComputeCapability'],list(capability))
                    self.assertEqual(value['cudaDeviceName'],'Unlisted GPU')
                    self.assertEqual(value['validatedGpuNames'],['NVIDIA RTX4090'])
    def test_missing_gpu_is_rejected(self):
        for driver in (FakeDriver(init=100),FakeDriver(device_status=101)):
            with self.subTest(driver=driver),self.assertRaisesRegex(ValueError,'GGUF_MANAGED_GPU_UNSUPPORTED'):
                self.query(driver)
    def test_missing_installed_driver_is_rejected(self):
        with patch.object(managed,'system_directory',return_value=self.system), \
                patch.object(managed.ctypes,'WinDLL',side_effect=OSError('fixture missing driver'),create=True), \
                self.assertRaisesRegex(ValueError,'GGUF_MANAGED_DRIVER_UNSUPPORTED'):
            managed.verify_gpu_support(self.admitted)
    def test_manual_and_vulkan_skip_cuda_queries(self):
        with patch.object(managed.ctypes,'WinDLL',side_effect=AssertionError('GPU call forbidden'),create=True):
            self.assertEqual(managed.verify_gpu_support(None),{})
            value=managed.verify_gpu_support(dict(self.admitted,runtimeId='qwen-vulkan',backend='Vulkan0'))
            self.assertEqual(value,dict(managedCudaCompatibilityQueried=False))


class IsolatedStartupTests(unittest.TestCase):
    def test_workers_import_only_adjacent_modules_under_isolated_python(self):
        script="import runpy,sys;runpy.run_path(sys.argv[1],run_name='__cpu_import_only__');import control;assert 'torch' not in sys.modules;print(control.__file__)"
        with tempfile.TemporaryDirectory() as scratch:
            foreign=Path(scratch)/'control.py';foreign.write_text("raise RuntimeError('foreign import')")
            for name in ('qwen_gguf_worker.py','voxcpm_windows_gguf_worker.py'):
                with self.subTest(worker=name):
                    value=subprocess.run([sys.executable,'-I','-B','-c',script,str(VOICE/name)],
                        env=dict(os.environ,PYTHONPATH=scratch),capture_output=True,text=True,timeout=20)
                    self.assertEqual(value.returncode,0,value.stderr)
                    self.assertEqual(Path(value.stdout.strip()),VOICE/'control.py')


if __name__=='__main__':unittest.main()
