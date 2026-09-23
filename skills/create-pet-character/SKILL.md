---
name: create-pet-character
description: Create a Daemonlet character or poses as an external .petchar pack, or add/update the persona of an existing pack from supplied character sources while preserving artwork and rigs.
---

# Daemonlet character production

## Choose the task first

- **Update source only:** Existing pack + confirmed public Hugging Face Dataset/feed location. Read [updates.md](references/updates.md), inspect the internal ID/version, and use `add-update-source` / `create-update-feed` / `publish-update-packs`. Preserve payload bytes and original packs; skip image, pose, persona and GPU questions. Recheck archive/install/distribution acceptance without claiming a new visual review.
- **Persona only:** Existing pack + personality/source material, with no new artwork or poses. Read [persona.md](references/persona.md) and use `validate-persona` / `upgrade-persona`. Skip all image, framing, pose-count, ComfyUI, Python and GPU questions below. Preserve the original archive and every visual/rig/dialogue byte. Do not rerun the independent payload builder.
- **New character or poses:** Follow the production inputs below. Use the same confirmed personality for pose/reaction planning, fixed dialogue and `persona.json`; read [persona.md](references/persona.md) before packaging. New packs include a validated persona unless the user explicitly requests omission.

Read [production.md](references/production.md) for executable commands and data contracts. Use `scripts/creator.mjs info` and `check` to locate and validate the supplied runtime. The source checkout and complete skill ZIP both include the required local tools; an instructions-only copy does not.

## Inputs

Reuse answers already given. Ask for:

- Reference image; if absent, the intended appearance and style. Inspect supplied artwork using the reference preparation step below. Use an available image-generation tool to create and show a reference before expanding poses when none was supplied. Image generation access is required for new pose artwork even when a reference was supplied.
- Framing: preserve the supplied framing for a thigh-up reference; do not ask to extend it to full-body or generate the missing lower body by default. For a full-body reference, ask the user to choose full-body or thigh-up before preparing pose artwork. Reuse an existing choice and apply it consistently across poses.
- Absolute ComfyUI installation path, that environment's Python, URL, NVIDIA GPU/VRAM and, when remote, the intended host and image-transfer destination. Do not reuse another person's paths or IP addresses.
- Display name, unique pack ID, props and intended use/distribution.
- Personality and dialogue preferences, following the personality confirmation below.
- The number of illustrations for each state and interaction, following the pose explanation below. Explain the choices before asking; wait for the user's selection before generating pose artwork.

Keep source-image provenance and note any unresolved input/model rights. See `external-dependencies.json` for external tools and compatible model IDs. Check external readiness early, before expanding pose artwork. When setup is needed, follow **Dependency setup with approval** below; do not treat a character request alone as permission to install, update or download dependencies.

### Personality confirmation

Ask what personality and speaking style the user wants, and request a source such as a character profile, setting notes, representative dialogue or a reference link. Do not infer personality from the reference image alone. For an original character without source material, ask for the user's intended traits and propose a short profile for confirmation.

For an existing character, establish the character's name, originating work and relevant version when ambiguous, then research their personality using available web tools, prioritizing official profiles and original-work material. Present a concise, linked summary of traits, speech style and likely interaction reactions, distinguish sourced facts from interpretation, and explicitly ask whether this is the personality the user intends. If research is unavailable or inconclusive, say so and request source material instead of inventing a profile. Respect requested adaptations and confirm them separately from the original characterization.

If the user explicitly asks to apply supplied character sources and they are consistent, apply them without repeating personality confirmation; retain source evidence and distinguish interpretation. Omit unsupported claims and leave material identity conflicts unresolved. Reuse an already confirmed profile. Otherwise wait for confirmation before using the personality to finalize pose expressions, reactions and dialogue; carry the agreed profile into the production plan.

### Explain poses and choose illustration counts

In the user's language, explain all ten poses before asking how many to create. Describe their purpose and propose character-appropriate expressions or gestures; the examples below are suggestions, not fixed artwork requirements.

| Pose | Purpose and example artwork |
| --- | --- |
| `waiting` | Normal waiting state; a relaxed neutral stance. |
| `writing` | Work in progress; concentrating or writing. |
| `failed` | Work failed; concern, surprise or frustration. |
| `cancelled` | Work was cancelled; pausing or acknowledging the interruption. |
| `disconnected` | Connection is unavailable; looking puzzled or waiting for reconnection. |
| `bored` | Prolonged inactivity; fidgeting, yawning or another idle activity. |
| `happy` | A happy reaction; smiling or celebrating. |
| `head-tap` | Head-click reaction; a brief response to a click on the head. |
| `torso-tap` | Torso-click reaction; a brief response to a click on the body. |
| `head-pet` | Head-petting reaction; responding to a stroking gesture, distinct from a click. |

Recommend either **one illustration per pose (10 total)** or **one per state/petting pose and three each for head-click and torso-click (14 total)**. The user may also choose three for only one click target (12 total). Click variants are distinct alternative reactions selected on separate interactions, not consecutive animation frames; each requires its own complete source illustration.

Ask the user to choose the counts, explicitly including head-click and torso-click. Show the resulting per-pose counts and total in the production plan before generation. Treat these as recommendations, not permission to add variants. If the user requests other counts or state variants, check runtime/export support before promising them, explain any limitation and agree on a supported plan. Reuse counts already selected; do not ask for the same decision again.

## Dependency setup with approval

If See-through or required models/packages are missing, incompatible or incomplete, offer to install or repair them instead of stopping at installation instructions. Reuse an explicit setup authorization already given for the same target and scope.

1. **Inspect first.** Confirm the actual host, ComfyUI root, its Python, URL and GPU; inspect installed revisions, model caches, import errors and `/object_info`. Use `scripts/check-environment.py` with that ComfyUI Python when available. Reuse suitable existing components. Distinguish a missing node pack, missing weights, an incomplete snapshot and a package incompatibility; a missing document is not evidence of damaged weights.
2. **Present a concrete plan and ask whether to perform it.** Identify the target paths, official sources and intended node/model revisions from `external-dependencies.json`, missing components, estimated download/disk requirements (or what remains unknown), and known or unresolved model terms. Separate new installation from updates to an existing environment. Disclose proposed Python package upgrades/downgrades, configuration edits, cache repairs and any server restart. Model installation approval should explicitly cover the named models' required files, including snapshot metadata/documentation; it is not a grant of model rights.
3. **Execute the approved scope.** Once approved, perform installation, model preparation and verification without asking again for each file or routine step. Use official Manager or manual installation as appropriate and the selected ComfyUI Python, not an unrelated system Python. Pin available compatible revisions and record the actual revisions/hashes. Before modifying an existing environment, preserve the relevant package list, node revision and changed configuration outside Git. Download only the approved model snapshots or missing files; do not enable unrestricted downloads for normal production. Stop and ask about a concrete scope change if an additional model, unrelated package change, different host or unapproved restart becomes necessary.
4. **Protect running work.** Check the queue and server activity before setup that affects a live environment, restarts or GPU tests. Wait for existing jobs; do not cancel them. An approved restart can proceed when the server is idle. If installation fails, report the partial changes and blocker; avoid repeated broad upgrades or deleting shared caches. Restore only changes made for this setup when restoration is safe and covered by the plan.
5. **Verify and resume.** After any approved restart, rerun the environment check, inspect import logs and required `/object_info` nodes, and verify local model loading with `auto_download=false`. Use the first agreed pose for one actual decomposition test, checking both loaders' VRAM-selected offload mode in the logs and saved layers/depth. Reuse that successful result in production. Package checks alone are not proof of inference readiness. Continue the agreed character task after validation; if setup is declined or blocked, preserve the artwork and report exactly which dependent stages remain unavailable.

Keep setup records, private paths and logs in the selected run outside Git and distributable packs. This workflow authorizes action only after the user's scoped approval; it does not change the read-only behavior of `creator.mjs check` or `check-environment.py`.

## Reference suitability and preparation

Inspect the supplied images before decomposition. Distinguish an identity/design reference from a production-ready single-pose illustration. Character sheets, opaque backgrounds, heavy lighting, fine overlapping hair and rough edges can require preparation; explain the specific issue and proposed correction instead of rejecting the reference or silently redesigning it. A thigh-up crop is valid framing, not missing anatomy to repair. A complete pose source means complete within the selected framing, not necessarily full-body.

Read [reference-preparation.md](references/reference-preparation.md) when a reference needs cleanup, extraction from a character sheet, background removal or missing-part reconstruction. Preserve face, defining features, clothing, colors and the selected pose; simplify only what is needed for production. Hair removal and pose changes are character-specific choices, not defaults. Preserve originals and show the prepared candidate for selection before expanding poses. Reuse an already selected suitable reference.

Normalize orientation/color/canvas with `scripts/prepare-reference.py` after any required image edits; it does not remove backgrounds or reconstruct hidden parts. Verify subject-background alpha and edges, not just the transparent padding added by normalization. A cleanup reference is separate from the agreed pose count unless it is explicitly selected as a final pose source.

## Production

Follow the agreed per-pose illustration counts and confirmed personality. Review waiting/writing/head-tap first, then complete the requested set; these initial three illustrations count toward the total.

Read [visual-review.md](references/visual-review.md) before the first decomposition and use its pilot and separate source/layers/visual/motion acceptance stages. A successful loader, overview or pack comparison never substitutes for both-eye/eyebrow and intermediate-expression review. Stop expanding a shared defect until the pilot repair is inspected.

Each pose gets its own body, head, eyes and mouth from its own illustration. Reuse tools, not another pose's Base artwork or coordinates. Use `independent-model` with identity registration. The built-in Gpichan uses an older supported strategy and is not a template to copy into new artwork.

See-through: 1280px, 30 steps and cached tag embeddings. **Enable group offload on both loaders only when the selected GPU has <=12 GiB total VRAM; disable it on both loaders above 12 GiB.** Use the ComfyUI server's selected CUDA device capacity, not free memory or a different client GPU. If capacity cannot be detected or multiple GPUs are ambiguous, obtain the selected GPU's capacity and pass it explicitly; do not guess. RTX 3060 12GB is the support target, not measured performance assurance. <=8GB is discouraged; if the user chooses to try, cap layer resolution at 1024 and depth at 720. Check the actual inference logs for the selected offload mode. Process one pose at a time without interrupting the user's other GPU jobs.

Match native layers and geometry to the source. Review eye/skin masks and hair shape for this character. Do not assume blue irises, a particular skin tone or fixed hand/face coordinates. Add image edits for missing expressions or occluded paint while preserving source identity and registered sheet coordinates.

Before local joint motion, inspect the isolated moving layer. If it also contains parts that must stay attached elsewhere (for example shoulder/torso or hair baked into an arm), split and restore hidden paint, or remake the affected layer, before rigging. Require full attachment-boundary coverage and enlarged full-cycle inspection; a stable pivot and sufficient hand travel do not establish a connected shoulder. See [motion-authoring.md](references/motion-authoring.md) for the layer review and connection evidence contract.

Default new production to visibly expressive, pose-specific motion at desktop size. Read [motion-authoring.md](references/motion-authoring.md): use preparation, action, small overshoot and settling; stagger head/body/free limbs and secondary hair/accessories. Fit pivots, influence and contact constraints to each illustration. Increase useful movement through rigging and timing, not a global amplitude multiplier. Respect a user request for restrained motion or the character's intended acting style.

## Validation and delivery

Verify blink/mouth/smile at eleven intermediate values, combined gaze/head states, 320/460/1280px, pose transitions, interruptions/re-entry, hand contact, click and petting. Inspect captures; parser and unit-test success alone does not establish visual quality. Create pose-specific motion rather than the same arm sway everywhere.

Build a payload outside `public/characters`, export `.petchar`, and import through the app UI. Check selection, reactions and restart. Never overwrite frozen runs or mutate the built-in catalog to install a new character. Report the pack, unsupported reactions and the actual scope of visual/rights checks. Treat production as supervised and iterative, not guaranteed unattended completion.

Use `creator.mjs review` as the current evidence ledger. The creator payload command requires current pose review passes; after export bind the final archive and record renderer/behavior/app/rights evidence. Asset changes invalidate previous reviews. Keep historical candidates and private evidence separate from the final pack; report disk usage independently of Git ignore status.

## Character Chat metadata and export

For an existing pack's chat/persona update, reuse artwork and rigs and skip image/GPU setup. Read `references/character-chat.md`. New production records `intendedMeaning` and `meaningReview` beside each final model ID in `models.json`. The payload and export commands compile confirmed intent into the referenced `chat.json` using the application's shared validator. Unknown intent remains unconnected; never infer confirmed meaning from pose names. For arbitrary IDs, declare the actual `basePoseId` in the production index rather than renaming poses. Existing legacy production indices remain supported.

Use `creator.mjs upgrade-chat` to create a new metadata-only candidate and a preservation report. Keep source evidence, authoring review and source archives outside the public repository. A pack export or semantic test is not visual acceptance; verify the desktop character and its local chat bubble, and distinguish injected meaning from actual model output.
