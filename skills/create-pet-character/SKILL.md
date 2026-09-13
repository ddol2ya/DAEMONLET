---
name: create-pet-character
description: Create Daemonlet character packs from reference images or an appearance description, using per-pose source artwork, the user's ComfyUI/See-through environment, local rigging tools and visual validation. Use for a new character or new poses; output an external .petchar pack.
---

# Daemonlet character production

Read [production.md](references/production.md) for executable commands and data contracts. Use `scripts/creator.mjs info` and `check` to locate and validate the supplied runtime. The source checkout and complete skill ZIP both include the required local tools; an instructions-only copy does not.

## Inputs

Reuse answers already given. Ask for:

- Reference image; if absent, the intended appearance and style. Use an available image-generation tool to create and show a reference before expanding poses. Image generation access is required for new pose artwork even when a reference was supplied.
- Absolute ComfyUI installation path, that environment's Python, URL, NVIDIA GPU/VRAM and, when remote, the intended host and image-transfer destination. Do not reuse another person's paths or IP addresses.
- Display name, unique pack ID, personality/dialogue, props and intended use/distribution.
- Whether head-click and torso-click should each have **one or three distinct pose illustrations**. Ask explicitly; do not generate extra variants before the answer. These are alternative reactions, not consecutive animation frames.

Keep source-image provenance and note any unresolved input/model rights. See `external-dependencies.json` for user-installed tools and compatible model IDs. Do not install/update ComfyUI or download weights automatically.

## Production

Preserve selected originals. Normalize reference orientation/color/canvas with `scripts/prepare-reference.py`; it does not remove backgrounds or reconstruct hidden parts. Inspect actual alpha and edges.

Default to one complete source illustration for each of ten poses: waiting, writing, failed, cancelled, disconnected, bored, happy, head-tap, torso-tap, head-pet. Both three-variant choices add four illustrations, for fourteen total. Review waiting/writing/head-tap first, then complete the requested set.

Each pose gets its own body, head, eyes and mouth from its own illustration. Reuse tools, not another pose's Base artwork or coordinates. Use `independent-model` with identity registration. The built-in Gpichan uses an older supported strategy and is not a template to copy into new artwork.

See-through: 1280px, 30 steps, cached tag embeddings and **group offload on both loaders**. RTX 3060 12GB is the support target, not measured performance assurance. <=8GB is discouraged; if the user chooses to try, cap layer resolution at 1024 and depth at 720. Check the actual inference logs for offload activation. Process one pose at a time without interrupting the user's other GPU jobs.

Match native layers and geometry to the source. Review eye/skin masks and hair shape for this character. Do not assume blue irises, a particular skin tone or fixed hand/face coordinates. Add image edits for missing expressions or occluded paint while preserving source identity and registered sheet coordinates.

## Validation and delivery

Verify blink/mouth/smile at eleven intermediate values, combined gaze/head states, 320/460/1280px, pose transitions, interruptions/re-entry, hand contact, click and petting. Inspect captures; parser and unit-test success alone does not establish visual quality. Create pose-specific motion rather than the same arm sway everywhere.

Build a payload outside `public/characters`, export `.petchar`, and import through the app UI. Check selection, reactions and restart. Never overwrite frozen runs or mutate the built-in catalog to install a new character. Report the pack, unsupported reactions and the actual scope of visual/rights checks. Treat production as supervised and iterative, not guaranteed unattended completion.
