# Daemonlet for Codex

Keep the default app limited to Gpichan. New characters are external `.petchar` packs.
Read `docs/character-production-workflow.md` before character/pose production.
Each new pose uses its own complete source illustration and `independent-model` rig;
preserve the older semantic-layer-swap runtime for compatible imported packs.
Match masks, geometry and expressions to the supplied artwork. Do not assume blue
irises, a particular skin tone or an earlier character's coordinates.
Preserve selected source artwork and existing user packs. Verify visual transitions,
interactions and the packaged app, not only parser/unit-test success.

ComfyUI, See-through and model weights are user-installed external dependencies.
Do not bundle them or automatically update an existing installation. Ask for the
ComfyUI root, its Python, URL and GPU before using the production skill.
Keep private paths, outputs, credentials, signing state and experiment artifacts out
of Git. Run relevant checks and keep source/release license notices intact.
