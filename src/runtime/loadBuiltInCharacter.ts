import type { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import type { RigOverrides } from "../engine/anime25d/RigOverrides"
import { loadBehaviorManifest } from "../behavior/BehaviorManifest"
import { loadDialogueManifest } from "../dialogue/DialogueManifest"
import type { LoadedCharacter } from "../pose/types"
import { loadRigAsync } from "../engine/anime25d/loadRigAsync"
import { loadPoseManifest, resolveManifestUrl } from "../pose/PoseManifest"
import { PoseAssetLoader } from "../pose/PoseAssetLoader"

export async function loadBuiltInCharacter(engine: Anime25DRuntime, model: LoadedCharacter, signal?: AbortSignal, beforeCommit?: () => void) {
  const [psdResponse, overrideResponse, behavior, dialogue, entries] = await Promise.all([
    fetch(model.baseUrls.psd, { cache: "no-store", signal }),
    model.baseUrls.overrides ? fetch(model.baseUrls.overrides, { cache: "no-store", signal }) : Promise.resolve(null),
    loadBehaviorManifest(model.behaviorManifestUrl, signal),
    loadDialogueManifest(model.dialogueManifestUrl, signal),
    Promise.all(model.poseManifestUrls.map(async manifestUrl => ({ manifestUrl, manifest: (await loadPoseManifest(manifestUrl, signal)).value }))),
  ])
  if (!psdResponse.ok) throw new Error(`${model.label} PSD could not be loaded (${psdResponse.status})`)
  if (overrideResponse && !overrideResponse.ok) throw new Error("Rig overrides could not be loaded")
  const overrides: RigOverrides = overrideResponse ? await overrideResponse.json() as RigOverrides : {}
  const buffer = await psdResponse.arrayBuffer()
  signal?.throwIfAborted()
  const result = await loadRigAsync(engine.loader, buffer, model.baseUrls.psd.split("/").at(-1) ?? `${model.id}.psd`, overrides, signal)
  const loader = new PoseAssetLoader(engine.loader)
  const warmed = []
  // Complete-pose packs often use the waiting PSD as their Base. Reuse that
  // exact model only when both source URLs and overrides match.
  for (const entry of entries) {
    if (resolveManifestUrl(entry.manifest.psd, entry.manifestUrl) !== model.baseUrls.psd
      || (entry.manifest.overrides ? resolveManifestUrl(entry.manifest.overrides, entry.manifestUrl) : undefined) !== model.baseUrls.overrides) continue
    warmed.push(await loader.load(entry.manifestUrl, result.model.rig, { signal, manifest: entry.manifest, prepared: result }))
  }
  signal?.throwIfAborted()
  const poses = engine.applyPreparedCharacter(result, {
    overrides,
    sourceReferenceUrl: model.baseUrls.source,
    characterId: model.id,
  }, entries, warmed, beforeCommit)
  return { result, poses, behavior, dialogue }
}
