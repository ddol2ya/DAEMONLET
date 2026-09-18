import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addUpdateSource } from "../scripts/characters/add-update-source.mjs"
import { createUpdateFeed } from "../scripts/characters/create-update-feed.mjs"
import { preparePublication } from "../scripts/characters/publish-update-packs.mjs"
import { extractCharacterPack } from "../electron/main/CharacterPackArchive"
import { sha256 } from "../electron/main/CharacterPackAssets"
import { writePack } from "./helpers/character-pack"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
describe("update-source creator tools", () => {
  it("preserves every payload byte and ID, generates an actual archive feed, and validates a dry-run allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-update-tools-")); roots.push(root)
    const input = await writePack(root, { id: "style-a" }), output = join(root, "new.petchar"), notes = join(root, "notes.txt")
    const result = await addUpdateSource({ input, output, version: "1.0.1", "repo-id": "fixture/characters", "manifest-path": "updates/style-a/stable.json" })
    expect(result.changedFiles).toEqual(["pack.json"]); expect(result.output.id).toBe("style-a"); expect(result.unchangedFiles).toHaveLength(4)
    expect(result.visualAssetChanges).toBe(0); expect(result.validation.visualReview).toBe("NOT_RUN")
    await writeFile(notes, "Metadata only")
    const feed = await createUpdateFeed({ pack: output, "artifact-path": "packs/style-a/1.0.1.petchar", "artifact-revision": "a".repeat(40), "min-app-version": "0.7.2", "notes-file": notes, output: join(root, "stable.json") })
    expect(feed.artifact.sha256).toBe(sha256(await readFile(output))); expect(feed.runtime).toEqual(result.output.runtime)
    const plan = { repoId: "fixture/characters", public: true, packs: [{ pack: output, packId: "style-a", manifestPath: "updates/style-a/stable.json", artifactPath: "packs/style-a/1.0.1.petchar", minAppVersion: "0.7.2", notes: "Metadata only" }], documents: [] }
    expect((await preparePublication(plan)).packs.map((p: { path: string }) => p.path)).toEqual(["packs/style-a/1.0.1.petchar"])
    await expect(preparePublication({ ...plan, documents: [{ file: input, path: "private.html" }] })).rejects.toThrow("Document not allowlisted")
    await expect(preparePublication({ ...plan, packs: [{ ...plan.packs[0], packId: "style-b" }] })).rejects.toThrow("mismatch")
    await expect(addUpdateSource({ input, output: join(root, "downgrade.petchar"), version: "1.0.0", "repo-id": plan.repoId, "manifest-path": plan.packs[0].manifestPath })).rejects.toThrow("PACK_DOWNGRADE")
    const stage = join(root, "final"); await mkdir(stage)
    expect((await extractCharacterPack(output, stage)).manifest.update?.repoId).toBe(plan.repoId)
  }, 30_000)
})
