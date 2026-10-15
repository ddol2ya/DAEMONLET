import type {ExecutionProfile} from './character-voice-contract'

export function voiceProfileBackend(profile: ExecutionProfile | undefined): 'cuda' | 'vulkan' | undefined {
  if (!profile || !/^(?:qwen-gguf(?:-vulkan)?|gguf-(?:cuda|vulkan)-f16)(?:-complete)?$/.test(profile)) return
  return profile.includes('vulkan') ? 'vulkan' : 'cuda'
}

export function voiceBackendProfile(profile: ExecutionProfile, backend: 'cuda' | 'vulkan'): ExecutionProfile {
  if (!voiceProfileBackend(profile)) return profile
  const suffix = profile.endsWith('-complete') ? '-complete' : ''
  return (profile.startsWith('qwen-') ? `qwen-gguf${backend === 'vulkan' ? '-vulkan' : ''}${suffix}` : `gguf-${backend}-f16${suffix}`) as ExecutionProfile
}

export function canRetryVoiceWithVulkan(error: unknown): boolean {
  return error instanceof Error && [
    'GGUF_MANAGED_DRIVER_UNSUPPORTED', 'GGUF_MANAGED_GPU_UNSUPPORTED',
    'QWEN_GGUF_CUDA_REQUIRED', 'QWEN_GGUF_GPU_REQUIRED', 'QWEN_GGUF_WORKER_ERROR',
    'VOX_GGUF_NATIVE_INIT', 'UNSUPPORTED_DEVICE',
  ].includes(error.message)
}
