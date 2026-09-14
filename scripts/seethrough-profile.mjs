export const GROUP_OFFLOAD_MAX_VRAM_GIB = 12

/** ComfyUI normally reports its selected device, not every GPU on the client. */
export function selectedComfyGpu(stats) {
  const devices = Array.isArray(stats?.devices) ? stats.devices.filter(device => device?.type === 'cuda') : []
  return devices.length === 1 ? devices[0] : null
}

export function vramGiBFromStats(stats) {
  const bytes = selectedComfyGpu(stats)?.vram_total
  return Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 ** 3 : null
}

/** @param {number} requestedResolution @param {number | null} vramGiB */
export function seethroughProfile(requestedResolution = 1280, vramGiB = null) {
  if (vramGiB === null) throw new Error('Cannot determine the selected ComfyUI GPU total VRAM. Pass its capacity as the final vram-GiB argument.')
  if (!Number.isFinite(vramGiB) || vramGiB <= 0) throw new Error('VRAM must be a positive finite GiB number')
  const lowMemory = vramGiB <= 8
  return {
    resolution: lowMemory ? Math.min(requestedResolution, 1024) : requestedResolution,
    depthResolution: lowMemory ? 720 : -1,
    groupOffload: vramGiB <= GROUP_OFFLOAD_MAX_VRAM_GIB,
    cacheTagEmbeds: true,
    warning: lowMemory
      ? 'VRAM 8GB 이하는 비권장입니다. 해상도를 최대 1024px, 깊이를 720px로 낮춥니다. OOM이 해결된다는 보장은 없습니다.'
      : vramGiB < 12
        ? 'See-through 최소 지원 목표는 RTX 3060 12GB입니다. 12GiB 이하에서는 group offload를 사용하지만 OOM이 해결된다는 보장은 없습니다.'
        : null,
  }
}
