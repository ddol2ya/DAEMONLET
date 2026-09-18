# Update source only

Use this workflow for an existing reviewed archive when adding or changing its HF update metadata. Do not ask for GPU, ComfyUI, images, pose counts or a new persona. Do not run the payload builder or bypass the visual review gate. Preserve the original archive. Inspect its internal IDs, version, revision, runtime, profile, poses, persona reference and provenance first.

Distinct appearances have distinct IDs and feeds. Preserve existing unique IDs, even if the name contains a different-looking version label. Only a confirmed collision warrants explicit `--new-id`; that produces a new installation and never removes the old ID. Increment the actual release SemVer independently of appearance labels and the app version.

```sh
node scripts/creator.mjs add-update-source \
  --input /work/approved.petchar --version 1.0.1 \
  --repo-id confirmed-owner/character-packs \
  --manifest-path updates/appearance-a/stable.json \
  --output /work/new/appearance-a-1.0.1.petchar
```

The tool validates the original and final ZIP with the application validator, including all rigs; excludes `pack.json` from the payload inventory; and writes a file-by-file preservation report next to the output. Every payload byte stays identical unless an explicit ID split changes `character.json`. No visual review is newly claimed: archive/byte preservation is separate from renderer, interaction, installation and restart acceptance.

For new character production, `export --repo-id ... --manifest-path ...` includes the optional descriptor and `hf-pack-updates-v1` capability. Without an explicit source, neither is added. Existing persona-only and `payload --reviewed` workflows remain unchanged.

After uploading the verified artifact and obtaining its full HF commit:

```sh
node scripts/creator.mjs create-update-feed \
  --pack /work/new/appearance-a-1.0.1.petchar \
  --artifact-path packs/appearance-a/1.0.1.petchar \
  --artifact-revision FULL_40_CHARACTER_ARTIFACT_COMMIT \
  --min-app-version 0.7.2 --notes-file /work/changes.txt \
  --output /work/feeds/stable.json
```

The feed extracts actual ID, version and runtime from the validated archive. Never publish a placeholder commit or a fabricated QA version. The source descriptor points to a stable feed on `main`; the feed pins the archive to an immutable commit.

`publish-update-packs --plan /work/plan.json --record /work/private-publish.json` is a full validation dry-run. The exact-file plan has `repoId`, `public: true`, `packs` (each with `pack`, `packId`, `artifactPath`, `manifestPath`, `minAppVersion`, `notes`) and `documents` (each with `file`, `path`). Permitted document targets are README.md, PROVENANCE.md, LICENSE.txt and SHA256SUMS.txt. No folder, wildcard or remote deletion is accepted. Keep the plan and resumable record outside Git and the public staging directory.

Only add `--publish` after the actual destination, public scope and exact allowlist have been established. `--create-repo` explicitly permits creating that public Dataset; an existing private/gated repo is rejected, never converted. The developer Python needs `huggingface_hub` and existing write authentication. If missing, propose an isolated developer environment and request setup approval; do not add it to the app or expose tokens in chat. Browser uploads to the same confirmed scope are an alternative when an authenticated session is available.

The helper uses the official HF API, checks immutable artifact paths, uploads artifacts first, verifies their sizes/SHA-256 anonymously, then publishes feeds with an expected parent commit. It retains a private resumable record. On a conflict or failed readback, stop; preserve the previous feed and existing files. Never overwrite published bytes at the same `(packId, version)`, force-push, erase history, or upload raw source HTML, private review evidence, standalone PSD directories, credentials or app binaries.

Keep provenance/license bytes intact. State unresolved original asset rights honestly; the application's MIT license does not grant rights to character artwork. Verify the extracted standalone creator ZIP outside the checkout, and redo packaged-app installation/transition/rollback/restart checks for the changed archive.
