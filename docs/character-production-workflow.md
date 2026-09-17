# Character production

The maintained workflow is [create-pet-character](../skills/create-pet-character/SKILL.md), with commands and input contracts in its [production reference](../skills/create-pet-character/references/production.md).

For metadata-only HF publication of an existing pack, use [update source only](../skills/create-pet-character/references/updates.md). Preserve each appearance ID and payload bytes; its actual pack version increases independently of its display name and the app version. No image/GPU setup is needed.

Create each pose from its own complete illustration and match its own geometry, expressions and hand contact. Preserve source artwork, selected revisions and frozen results. New characters use independent-model rigs and external `.petchar` packs; Gpichan remains the sole built-in. Never install a new character by editing the built-in catalog.

Use the shared production tools and actual renderer for intermediate blink/mouth shapes, transitions and interaction inspection. Import the final pack through the packaged app and verify reactions/restart. A successful parser alone is not visual acceptance.

Inspect isolated layers before assigning movement. When movable and fixed parts are baked together, split and reconstruct the hidden paint or remake the affected layer before rigging. Verify complete attachment boundaries throughout the motion cycle; travel distance or one pinned root cannot establish that a shoulder remains connected.

Start with a fully reviewed pilot before pose expansion. Follow the [visual review and evidence ledger](../skills/create-pet-character/references/visual-review.md); current asset fingerprints determine whether a prior pass still applies. Author [expressive motion](../skills/create-pet-character/references/motion-authoring.md) with measured pivots, visible desktop-size travel and preserved contacts. Capture source/renderer eye and mouth strips, light/dark outlines and motion peaks before marking a candidate ready.
