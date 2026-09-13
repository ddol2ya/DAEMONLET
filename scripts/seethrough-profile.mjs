/** @param {number} requestedResolution @param {number | null} vramGiB */
export function seethroughProfile(requestedResolution = 1280, vramGiB = null) {
  const lowMemory = vramGiB !== null && vramGiB <= 8
  return {
    resolution: lowMemory ? Math.min(requestedResolution, 1024) : requestedResolution,
    depthResolution: lowMemory ? 720 : -1,
    groupOffload: true,
    cacheTagEmbeds: true,
    warning: lowMemory
      ? 'VRAM 8GB 이하는 비권장입니다. 해상도를 최대 1024px, 깊이를 720px로 낮춥니다. OOM이 해결된다는 보장은 없습니다.'
      : vramGiB === null || vramGiB < 12
        ? 'See-through 제작 기준은 RTX 3060 12GB 이상 + group offload입니다. GPU/VRAM과 실제 offload 활성화를 확인하세요.'
        : null,
  }
}
