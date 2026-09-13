# Daemonlet for Codex

Keep the default app limited to Gpichan. New characters are external `.petchar` packs.
Read `docs/character-production-workflow.md` before character/pose production.
Each new pose uses its own complete source illustration and `independent-model` rig;
preserve the older semantic-layer-swap runtime for compatible imported packs.
Match masks, geometry and expressions to the supplied artwork. Do not assume blue
irises, a particular skin tone or an earlier character's coordinates.
Preserve selected source artwork and existing user packs. Verify visual transitions,
interactions and the packaged app, not only parser/unit-test success.

ComfyUI, See-through and model weights are external dependencies; do not bundle them.
Ask for the ComfyUI root, its Python, URL and GPU before using the production skill.
If dependencies are missing or incompatible, offer a concrete installation or repair
plan and ask for approval. After approval, carry out setup and validation within
that scope without per-file reconfirmation. Disclose changes to existing packages
and any restart before approval; do not update an existing installation implicitly.
Keep production model auto-download disabled. Follow the production skill's setup
workflow, including unresolved model terms and protection of running GPU jobs.
Keep private paths, outputs, credentials, signing state and experiment artifacts out
of Git. Run relevant checks and keep source/release license notices intact.
