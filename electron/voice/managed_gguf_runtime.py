"""Read-only admission of app-local GGUF components from an app-pinned catalog.

An active receipt grants no trust. The app must verify before the first Python
spawn; this helper independently verifies the executing interpreter and every
required component. Import/admit perform no downloads, installation, Torch
import, native load or GPU calls. The separate compatibility query is called
only by worker initialization; the read-only checker never calls it.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys

CATALOG_NAME = 'managed-gguf-runtime-catalog.json'
OWNER = 'daemonlet-managed-gguf-runtime'
CATALOG_OWNER = 'daemonlet-managed-gguf-runtime-catalog'
COMPONENT_OWNER = 'daemonlet-managed-gguf-runtime-component'
COMPACT_LAYOUT = 'compact-v1'
RUNTIMES = {'qwen-cuda': ('qwen3-tts-06b-gguf', 'cuda'), 'qwen-vulkan': ('qwen3-tts-06b-gguf', 'vulkan'),
            'vox-cuda': ('voxcpm2', 'cuda'), 'vox-vulkan': ('voxcpm2', 'vulkan')}
COMPONENTS = {'shared', 'cuda-redist', *RUNTIMES}
ERROR = 'GGUF_MANAGED_RUNTIME_CHANGED'


def fail():
    raise ValueError(ERROR)


def ordinary(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path != Path(os.path.normpath(path)):
        fail()
    for item in (path, *path.parents):
        info = item.lstat()
        if item.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            fail()
    if directory and not path.is_dir() or not directory and not path.is_file():
        fail()
    return path.resolve()


def relative(value):
    if (not isinstance(value, str) or not value or len(value) > 240 or '\\' in value
            or ':' in value or '\x00' in value or any(ord(ch) < 32 for ch in value)):
        fail()
    parts = value.split('/')
    if len(parts) > 20 or any(not part or part in ('.', '..') or part[-1:] in (' ', '.')
            or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I) for part in parts):
        fail()
    return Path(*parts)


def digest(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        fail()
    return value


def read(path, record=None, maximum=8*1024*1024):
    path = ordinary(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 1 <= before.st_size <= maximum:
            fail()
        raw = source.read(before.st_size + 1); after = os.fstat(source.fileno())
    if len(raw) != before.st_size or any(getattr(before, key) != getattr(after, key)
            for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
        fail()
    if record is not None:
        check_record(record)
        if before.st_size != record['bytes'] or hashlib.sha256(raw).hexdigest() != record['sha256']:
            fail()
    return raw


def check_record(record):
    if (not isinstance(record, dict) or type(record.get('bytes')) is not int
            or record['bytes'] < 0):
        fail()
    digest(record.get('sha256'))


def full_hash(path, record):
    check_record(record); path = ordinary(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_size != record['bytes']):
            fail()
        result = hashlib.file_digest(source, 'sha256').hexdigest()
        after = os.fstat(source.fileno())
    if result != record['sha256'] or any(getattr(before, key) != getattr(after, key)
            for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
        fail()


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail()
        result[key] = value
    return result


def parse(raw):
    def invalid(_):
        fail()
    return json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicates, parse_constant=invalid)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def records(value):
    if isinstance(value, dict):
        rows = list(value.values())
        if any(not isinstance(row, dict) or row.get('id') != key for key, row in value.items()):
            fail()
    elif isinstance(value, list):
        rows = value
    else:
        fail()
    result = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or row['id'] in result:
            fail()
        result[row['id']] = row
    return result


def hash_files(jobs):
    """Managed-only rolling full hashes; drain started reads before any return."""
    # Manual admission returns before this import. The preceding app full-SHA
    # check still admits the bundled stdlib before this helper can execute it.
    executor = None
    pending = set()
    try:
        from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
        try:
            executor = ThreadPoolExecutor(max_workers=4)
            iterator = iter(jobs)
            exhausted = False
            while pending or not exhausted:
                while not exhausted and len(pending) < 4:
                    try:
                        path, record = next(iterator)
                    except StopIteration:
                        exhausted = True
                        break
                    pending.add(executor.submit(full_hash, path, record))
                if pending:
                    completed, _ = wait(pending, return_when=FIRST_COMPLETED)
                    error = None
                    # Inspect the entire completed batch before any refill.
                    for future in completed:
                        try:
                            future.result()
                        except BaseException as caught:
                            if error is None:
                                error = caught
                    if error is not None:
                        raise error
                    pending.difference_update(completed)
        finally:
            if executor is not None:
                try:
                    executor.shutdown(wait=True, cancel_futures=True)
                except BaseException:
                    for future in pending:
                        try:
                            future.result()
                        except BaseException:
                            pass
                    # Preserve the first shutdown error, but also let a
                    # transient scheduler failure finish its thread cleanup.
                    try:
                        executor.shutdown(wait=True, cancel_futures=True)
                    except BaseException:
                        pass
                    raise
                finally:
                    # A scheduler/shutdown error must not bypass real reads
                    # already represented by futures. result waits for close.
                    for future in pending:
                        try:
                            future.result()
                        except BaseException:
                            pass
    except Exception:
        fail()


def verify_component(root, component, layout=None):
    identity = component['id']
    if identity not in COMPONENTS:
        fail()
    archive = component.get('archive')
    check_record(archive)
    if archive.get('format') != 'zip' or archive['bytes'] <= 0:
        fail()
    if layout == COMPACT_LAYOUT:
        path = ordinary(root / 'c' / identity / archive['sha256'][:12], True)
    elif layout is None:
        path = ordinary(root / 'components' / identity / archive['sha256'], True)
    else:
        fail()
    files = component.get('files')
    if not isinstance(files, dict) or not files or len(files) > 20000:
        fail()
    allowed_dirs = set(); folded = set()
    for name, record in files.items():
        part = relative(name); check_record(record)
        if name.casefold() in folded:
            fail()
        folded.add(name.casefold())
        allowed_dirs.update(parent.as_posix() for parent in part.parents if parent != Path('.'))
    observed = set()
    def jobs():
        for entry in path.rglob('*'):
            name = entry.relative_to(path).as_posix()
            ordinary(entry, entry.is_dir())
            if entry.is_dir():
                if name not in allowed_dirs:
                    fail()
            elif entry.is_file():
                if name not in files:
                    fail()
                yield entry, files[name]
                observed.add(name)
            else:
                fail()
    hash_files(jobs())
    if observed != set(files):
        fail()
    return path


def admit(configuration, policy, runtime_id, native_dir, native_receipt=None):
    """None preserves manual policy; a supplied managed config must fully verify."""
    if configuration is None:
        return None
    try:
        if (not isinstance(configuration, dict) or set(configuration) != {'root', 'receipt', 'runtimeId'}
                or configuration.get('runtimeId') != runtime_id or runtime_id not in RUNTIMES):
            fail()
        if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64'):
            fail()
        pin = policy.get('managedRuntimeCatalog')
        if not isinstance(pin, dict) or pin.get('filename') != CATALOG_NAME:
            fail()
        catalog_path = Path(__file__).with_name(CATALOG_NAME)
        catalog_raw = read(catalog_path, pin)
        catalog = parse(catalog_raw)
        if (type(catalog.get('schemaVersion')) is not int or catalog['schemaVersion'] != 1
                or catalog.get('platform') != 'win32-x64'):
            fail()
        catalog_sha = hashlib.sha256(catalog_raw).hexdigest()
        components = records(catalog.get('components')); runtimes = records(catalog.get('runtimes'))
        runtime = runtimes.get(runtime_id)
        engine, backend = RUNTIMES[runtime_id]
        if (not isinstance(runtime, dict) or runtime.get('engine') != engine
                or runtime.get('backend') != ('CUDA0' if backend == 'cuda' else 'Vulkan0')
                or runtime.get('pythonVersion') != '3.11.15' or platform.python_version() != '3.11.15'):
            fail()
        required = runtime.get('components')
        if (not isinstance(required, list) or not required or len(required) != len(set(required))
                or not all(isinstance(name, str) and name in components for name in required)
                or set(required) != ({'shared', runtime_id, 'cuda-redist'} if backend == 'cuda' else {'shared', runtime_id})):
            fail()
        root = ordinary(configuration['root'], True)
        receipt_path = ordinary(configuration['receipt'])
        if not receipt_path.is_relative_to(root) or receipt_path.is_relative_to(root / 'components'):
            fail()
        receipt_raw = read(receipt_path, maximum=65536)
        active = parse(receipt_raw)
        if not isinstance(active, dict) or type(active.get('schemaVersion')) is not int:
            fail()
        layout = None
        if active['schemaVersion'] == 2 and active.get('layout') == COMPACT_LAYOUT:
            layout = COMPACT_LAYOUT
            if receipt_path.is_relative_to(root / 'c'):
                fail()
        elif active['schemaVersion'] != 1:
            fail()
        expected_receipt = dict(schemaVersion=1, owner=OWNER, id=runtime_id, catalogSha256=catalog_sha,
                                components=[dict(id=name, fingerprint=digest(components[name]['archive']['sha256'])) for name in required])
        if layout is not None:
            expected_receipt.update(schemaVersion=2, layout=layout)
        if canonical(active) != canonical(expected_receipt):
            fail()
        metadata_reads = []
        if layout == COMPACT_LAYOUT:
            marker_path = root / '.catalog.json'
            marker_raw = read(marker_path, maximum=65536)
            expected_marker = dict(schemaVersion=1, owner=CATALOG_OWNER,
                                   catalogSha256=catalog_sha, layout=layout)
            if canonical(parse(marker_raw)) != canonical(expected_marker):
                fail()
            metadata_reads.append((marker_path, marker_raw))
            for name in required:
                component = components[name]
                fingerprint = digest(component['archive']['sha256'])
                if not isinstance(component.get('provenance'), dict):
                    fail()
                component_receipt = root / 'component-receipts' / (name + '-' + fingerprint + '.json')
                component_raw = read(component_receipt, maximum=65536)
                expected_component = dict(schemaVersion=1, owner=COMPONENT_OWNER, id=name,
                                          fingerprint=fingerprint, provenance=component['provenance'])
                if canonical(parse(component_raw)) != canonical(expected_component):
                    fail()
                metadata_reads.append((component_receipt, component_raw))
        paths = {name: verify_component(root, components[name], layout) for name in required}

        def located(record, directory=False):
            if (not isinstance(record, dict) or set(record) != {'component', 'path'}
                    or record.get('component') not in paths):
                fail()
            target = paths[record['component']] / relative(record['path'])
            return ordinary(target, directory)

        python = located(runtime.get('python'))
        if runtime['python']['component'] != 'shared' or python != ordinary(sys.executable):
            fail()
        native = located(runtime.get('native'), True)
        if runtime['native']['component'] != runtime_id or native != ordinary(native_dir, True):
            fail()
        receipt = None
        if runtime_id.startswith('vox-'):
            receipt = located(runtime.get('receipt'))
            if runtime['receipt']['component'] != runtime_id or native_receipt is None or receipt != ordinary(native_receipt):
                fail()
        elif runtime.get('receipt') is not None or native_receipt is not None:
            fail()
        dependencies = runtime.get('dependencyDirs')
        if not isinstance(dependencies, list) or not dependencies:
            fail()
        dependency_dirs = []; dependency_components = []
        for item in dependencies:
            if not isinstance(item, dict) or item.get('component') not in ('shared', 'cuda-redist'):
                fail()
            dependency_dirs.append(located(item, True)); dependency_components.append(item['component'])
        if (len(dependency_dirs) != len(set(dependency_dirs))
                or set(dependency_components) != ({'shared', 'cuda-redist'} if backend == 'cuda' else {'shared'})):
            fail()
        # Re-read the receipt after component hashes to catch a concurrent swap.
        if read(receipt_path, maximum=65536) != receipt_raw:
            fail()
        for path, raw in metadata_reads:
            if read(path, maximum=65536) != raw:
                fail()
        return dict(runtimeId=runtime_id, root=root, python=python, native=native,
                    nativeReceipt=receipt, dependencyDirs=dependency_dirs, components=paths,
                    catalogSha256=catalog_sha, pythonVersion=runtime['pythonVersion'],
                    backend=runtime['backend'], support=runtime.get('support'), layout=layout, verified=True)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise ValueError(ERROR) from None


def system_directory():
    """Use the OS system directory rather than a caller-controlled SystemRoot."""
    if sys.platform != 'win32':
        fail()
    kernel = ctypes.WinDLL('kernel32', use_last_error=True, winmode=0x800)
    kernel.GetSystemDirectoryW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint]
    kernel.GetSystemDirectoryW.restype = ctypes.c_uint
    buffer = ctypes.create_unicode_buffer(32768)
    length = kernel.GetSystemDirectoryW(buffer, len(buffer))
    if not 0 < length < len(buffer):
        fail()
    return ordinary(buffer.value, True)


def managed_path(admitted):
    if not admitted or admitted.get('verified') is not True:
        fail()
    return os.pathsep.join(str(path) for path in [admitted['native'], *admitted['dependencyDirs'], system_directory()])


def audit(admitted):
    return dict(managedRuntimeVerified=bool(admitted and admitted.get('verified') is True),
                managedRuntimeId=admitted['runtimeId'] if admitted else None,
                managedRuntimeCatalogSha256=admitted['catalogSha256'] if admitted else None)


def verify_gpu_support(admitted):
    """Worker-initialize-only CUDA compatibility query; never called by --verify.

Manual/Vulkan admission preserves the existing native GPU verification. CUDA
queries use only the installed driver in the OS system directory. No inference,
driver installation, fallback, downloads or persistent settings changes occur.
Compute capability and device names are diagnostic information, not an allowlist.
The native worker must still load and execute successfully on the selected GPU.
"""
    if not admitted:
        return {}
    if admitted.get('verified') is not True or admitted.get('runtimeId') not in RUNTIMES:
        fail()
    if admitted.get('backend') != 'CUDA0':
        if admitted.get('backend') != 'Vulkan0':
            fail()
        return dict(managedCudaCompatibilityQueried=False)
    support = admitted.get('support')
    if (not isinstance(support, dict) or type(support.get('minimumCudaDriverApi')) is not int
            or support['minimumCudaDriverApi'] < 13000
            or not isinstance(support.get('validatedGpuNames'), list)
            or not isinstance(support.get('validationScope'), str)):
        fail()
    try:
        driver_path = ordinary(system_directory() / 'nvcuda.dll')
        driver = ctypes.WinDLL(str(driver_path), winmode=0x800)
        signatures = {
            'cuInit': [ctypes.c_uint], 'cuDriverGetVersion': [ctypes.POINTER(ctypes.c_int)],
            'cuDeviceGet': [ctypes.POINTER(ctypes.c_int), ctypes.c_int],
            'cuDeviceComputeCapability': [ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.c_int],
            'cuDeviceGetName': [ctypes.c_void_p, ctypes.c_int, ctypes.c_int],
        }
        for name, arguments in signatures.items():
            function = getattr(driver, name); function.argtypes = arguments; function.restype = ctypes.c_int
        status = driver.cuInit(0)
        if status == 100:
            raise ValueError('GGUF_MANAGED_GPU_UNSUPPORTED')
        if status != 0:
            raise ValueError('GGUF_MANAGED_DRIVER_UNSUPPORTED')
        version = ctypes.c_int()
        if driver.cuDriverGetVersion(ctypes.byref(version)) != 0 or version.value < support['minimumCudaDriverApi']:
            raise ValueError('GGUF_MANAGED_DRIVER_UNSUPPORTED')
        device = ctypes.c_int(); major = ctypes.c_int(); minor = ctypes.c_int()
        if (driver.cuDeviceGet(ctypes.byref(device), 0) != 0
                or driver.cuDeviceComputeCapability(ctypes.byref(major), ctypes.byref(minor), device.value) != 0):
            raise ValueError('GGUF_MANAGED_GPU_UNSUPPORTED')
        name = ctypes.create_string_buffer(256)
        if driver.cuDeviceGetName(name, len(name), device.value) != 0 or not name.value:
            raise ValueError('GGUF_MANAGED_GPU_UNSUPPORTED')
        return dict(managedCudaCompatibilityQueried=True, cudaDriverApiVersion=version.value,
                    cudaComputeCapability=[major.value, minor.value], cudaDeviceOrdinal=0,
                    cudaDeviceName=name.value.decode('utf-8', errors='replace'),
                    validatedGpuNames=support['validatedGpuNames'], validationScope=support['validationScope'],
                    driverBranchIndependentlyVerified=False)
    except ValueError:
        raise
    except (OSError, AttributeError, TypeError):
        raise ValueError('GGUF_MANAGED_DRIVER_UNSUPPORTED') from None
