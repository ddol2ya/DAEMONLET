import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Transpile the shared validator for creator CLIs; no application build is invoked.
export async function withPackTools(action) {
  const dir = await mkdtemp(join(tmpdir(), 'petchar-tools-'))
  try {
    const outfile = join(dir, 'tools.mjs')
    await build({ stdin: { contents: `export * from './electron/main/CharacterPackAssets'; export * from './electron/main/CharacterPackArchive'; export * from './electron/shared/character-persona'; export * from './electron/shared/character-pack-contract'; export * from './electron/shared/character-pack-path'; export { parseBehaviorManifest, behaviorUsesPoseVariants } from './src/behavior/BehaviorManifest'; export { parseDialogueManifest } from './src/dialogue/DialogueManifest'; export { parsePoseManifest } from './src/pose/PoseManifest'; export { PsdRigLoader } from './src/engine/anime25d/PsdRigLoader'; export { initializeCanvas } from 'ag-psd';`, resolveDir: resolve(import.meta.dirname, '../..') }, outfile, platform: 'node', format: 'esm', bundle: true, logLevel: 'silent', banner: { js: `import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);` } })
    return await action(await import(pathToFileURL(outfile).href))
  } finally { await rm(dir, { recursive: true, force: true }) }
}
