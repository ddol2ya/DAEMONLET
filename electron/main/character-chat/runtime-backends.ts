import type {GpuBackend, GpuBackendPreference} from '../../shared/gpu-backend'
import {windowsBackendOrder} from '../../shared/gpu-backend'

export type RuntimeDevice = {backend: GpuBackend; id: string; name: string}
export type RuntimeBackendEntry = {backend: string; executable: string; launcher?: string; backends?: Partial<Record<GpuBackend, string>>}

export function runtimeBackendOrder(entry: RuntimeBackendEntry, preference: GpuBackendPreference): GpuBackend[] {
  if (entry.backend === 'Metal') return preference === 'auto' ? ['Metal'] : []
  return windowsBackendOrder(preference).filter(backend => entry.backends?.[backend] || entry.backend === backend)
}

export function runtimeArguments(entry: RuntimeBackendEntry, backend: GpuBackend, args: string[]): string[] {
  return entry.launcher && entry.backends ? ['--daemonlet-backend', backend, ...args] : args
}

export function runtimeDevice(output: string, backend: GpuBackend): RuntimeDevice | null {
  // --list-devices lists the native runtime's usable devices. Ignore diagnostic
  // chatter and software Vulkan implementations; never select a CPU backend.
  const prefix = backend === 'Metal' ? '(?:MTL|Metal)' : backend
  const match = new RegExp('^\\s*(' + prefix + '\\d+):\\s*(.+)$', 'gm')
  for (const value of output.matchAll(match)) {
    if (/llvmpipe|lavapipe|swiftshader|software rasterizer/i.test(value[2])) continue
    return {backend, id: value[1], name: value[2].replace(/\s*\(\d+\s*(?:MiB|GiB).*$/, '').trim()}
  }
  return null
}

export function runtimeBackendLoaded(log: string, device: RuntimeDevice): boolean {
  if (device.backend === 'Metal') return /Metal|MTL0/.test(log)
  return new RegExp('(?:^|[^\\w])' + device.id + '(?:$|[^\\w])').test(log)
}
