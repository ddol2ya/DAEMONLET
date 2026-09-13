# External dependency review — 2026-09-13

This is a review of public upstream declarations at specific revisions, not an
audit of an installed production environment or every component's provenance.
No engine, plugin, model weights, account or signing credentials were downloaded
or updated. The app and creator ZIP do not bundle these external dependencies.

| Item | Revision | Finding |
| --- | --- | --- |
| ComfyUI code | `02d39c8cd7828566f48ccf783c1c75b8336044f5` | GPL v3 full text verified in [LICENSE](https://github.com/Comfy-Org/ComfyUI/blob/02d39c8cd7828566f48ccf783c1c75b8336044f5/LICENSE) |
| ComfyUI-See-through plugin code | `98d754bf04f668647919ab750eccb0e0640faa81` | MIT declared in [pyproject.toml](https://github.com/jtydhr88/ComfyUI-See-through/blob/98d754bf04f668647919ab750eccb0e0640faa81/pyproject.toml); root tree has no LICENSE file. Declaration recorded, full notice review pending |
| layerdifforg/seethroughv0.0.2_layerdiff3d weights | `966721bb4ef2ddc3af3696862fa10b3f78d9785d` | Apache-2.0 declared in the exact [model card](https://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d/blob/966721bb4ef2ddc3af3696862fa10b3f78d9785d/README.md). [Tree](https://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d/tree/966721bb4ef2ddc3af3696862fa10b3f78d9785d) has no separate LICENSE. Component provenance and installed revision not verified |
| layerdifforg/seethroughv0.0.1_marigold weights | `aa7a892f83ff68d7b09186a405ba08d5d33f770f` | **Unverified/pending.** Exact [tree](https://huggingface.co/layerdifforg/seethroughv0.0.1_marigold/tree/aa7a892f83ff68d7b09186a405ba08d5d33f770f) has no README or LICENSE; model API provides no license metadata |

The LayerDiff3D card links the official [research repository](https://github.com/shitagaki-lab/see-through).
Its README links a different Marigold namespace and its Apache code license is
not sufficient evidence of permission for the exact layerdifforg weights used
here. The plugin's MIT declaration also cannot resolve that gap. Obtain an
applicable upstream statement for those exact weights and record the installed
revision before declaring the production environment's rights review complete.
No message to upstream has been sent.

No output-specific restriction was found in the reviewed LayerDiff3D card.
Marigold conditions, including any output-specific clauses, remain unknown.
This does not establish that generated Gpichan assets automatically inherit a
weight license or are unlawful. Source-image rights, any applicable output
restriction, and the specific production use must be considered separately.
The Gpichan grant is limited to rights the provider has authority to license.

The machine-readable evidence is in
[external-dependencies.json](../skills/create-pet-character/external-dependencies.json).
`declared` and `unverified` remain pending in the combined creator review. A
successful runtime/GPU check or warning acknowledgement never converts them to
`verified`. `auto_download: false`, user installation and no automatic update
remain unchanged; no GPU or engine access is needed for policy/build checks.

The [OpenAI individual Terms of Use](https://openai.com/policies/row-terms-of-use/)
were read for the recorded image-generation provenance. Their content terms
address rights between OpenAI and the user to the extent permitted by law and
exclude others' outputs/third-party output from that assignment. They are not
proof of global copyright status or clearance of third-party rights. The exact
account/service contract used to create the images was not inspected.
