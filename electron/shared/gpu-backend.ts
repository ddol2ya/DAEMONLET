export const GPU_BACKEND_PREFERENCES = ['auto', 'cuda', 'vulkan'] as const
export type GpuBackendPreference = typeof GPU_BACKEND_PREFERENCES[number]
export type GpuBackend = 'CUDA' | 'Vulkan' | 'Metal'
export function isGpuBackendPreference(value: unknown): value is GpuBackendPreference {
  return typeof value === 'string' && GPU_BACKEND_PREFERENCES.includes(value as GpuBackendPreference)
}
export function windowsBackendOrder(preference: GpuBackendPreference): Array<'CUDA' | 'Vulkan'> {
  return preference === 'auto' ? ['CUDA', 'Vulkan'] : [preference === 'cuda' ? 'CUDA' : 'Vulkan']
}
