# Visual review and candidate acceptance

Read for new artwork/rig production and visual repairs. Persona-only repackaging skips these stages. Use this alongside production.md; it does not grant installation, download or external publishing permission.

## Pilot before expansion

Review the first agreed pose through source → layers → expressions → motion before expanding the remaining poses. Waiting/writing/head-tap remain the initial small set, counted within the agreed total. A single overview or successful decomposition is insufficient to establish the pipeline. When a defect repeats across poses, stop expansion, identify the shared cause, repair one pilot and verify it before batch application.

## Four separate pose checks

| Stage | Evidence required before recording pass |
| --- | --- |
| `source` | Identity, chosen framing, outfit/accessories and pose match; actual alpha and enlarged outline previews on white/dark. |
| `layers` | Isolated parts match their intended motion: no fixed shoulder/torso/hair baked into a moving limb. Split/reconstruct/remake contaminated parts before rigging, then inspect underpaint and recomposition. Face is the face rather than a larger skin island; hair contains no skin/clothing contamination; expression backing contains no old eyes/brows/lips. |
| `visual` | Actual renderer: both eyes, iris/pupil, lashes, brows, nose, mouth and surrounding skin; blink/mouth/smile at all 11 values; head/gaze/combined states; full-body seams and transparency at 320/460/1280px. |
| `motion` | Pose-specific action visible at intended display size, continuous loop/settle, full attachment boundaries and hand contact, delayed hair/accessory motion, silhouette and clothing boundaries throughout the cycle including exact peaks. Inspect enlarged connection crops on light/dark backgrounds and the attachment audit; root/travel alone cannot pass. Review entry/exit/interruption as well. |

`capture --source <run> --output <fresh QA> --motion --contacts` captures static states even when contacts are requested. It creates `review.html`, source/neutral comparison, both eye/brow crops, mouth/smile strips, 320/460/1280 viewing controls and light/dark backgrounds. Open and inspect the gallery and videos; creation does not record a visual pass. Contact capture needs per-model `motion-authorship.json` with `landmarks`, and for local joint motion the isolated-layer reviews and boundary `connections` specified in [motion-authoring.md](motion-authoring.md). Enlarged transparent connection crops cover every sample, including exact keyframe peaks. Failed connection measurements are retained as evidence and fail the command, even when hand travel passes.

The eye triangle check at blink 30–70% detects mesh inversion; it does not prove a natural eyelid, intact eyelashes or a correctly masked iris. Likewise, exact source-vs-payload pixels prove packaging fidelity, not artwork quality. Capture folders are fresh and bound to a source fingerprint; source mutation during capture fails that run.

## Diagnose before another repair

- Compare source, isolated part and rendered composite at the same coordinates. Determine whether the error is painted in the source, belongs to a mask, comes from alpha/color compositing, or appears only during deformation.
- A white crescent on an iris may come from antialiasing being blended twice. Do not hard-code an iris color or replace all eyes with circles. Preserve the source iris and measured lid contours, including eyes partly hidden by hair.
- Inspect skin underneath every movable eye, eyebrow and lip. Rectangular source patches can hide a ghost in neutral and expose it during transitions. Bounds describe a search region; they are not a final rectangular alpha mask.
- `geometry.faceComponentPoint: [x,y]` selects the skin component containing a reviewed point in that pose. It records excluded components; decide their actual semantic class separately. Never automatically call discarded skin legwear.
- `geometry.sourceEyeMasks: {l: "masks/eye-left.png", r: "masks/eye-right.png"}` uses reviewed 1280px grayscale aperture masks instead of color threshold inference. `featureMasks` maps an expression part name to a pose-local grayscale **trim** mask. These do not create missing paint or automatically repair a bad iris/lid; inspect the resulting geometry and backing.
- `geometry.neutralMouthMask` uses a reviewed grayscale source lip mask when automatic contrast extraction drops a light-separated lip corner. Include the complete source lip, not just its darkest connected piece; inspect every transition against the cleared skin backing.
- A noisy transparent outline can originate in already-painted background remnants. Alpha erosion/blur alone can remove the intended line or thicken it. Repair the source outline with the original line color/weight, rematte and inspect gaps around fingers, ribbons and hair. Do not make a uniform sticker stroke or make pale clothing transparent.
- Check that an edited edge still fits its layer bounds and motion geometry. Compare face/eyes and interior artwork after edge-only repairs. Preserve originals and previous selections; do not promote a character-specific threshold or coordinate into a universal repair.
- Use floating point for color subtraction/blending, then clamp and quantize once. Inspect both light and dark previews after changes.
- If a second candidate repeats the same defect or changes identity, stop blind parameter retries. Reinspect decomposition/registration, choose a different repair method or disclose the actual blocker. This is a diagnostic checkpoint, not an automatic permission question.

## One current review ledger

`creator.mjs review --source <run>` reports derived current status and fingerprints from `models.json` and referenced assets. `production-review.json` holds evidence history, not manually maintained completed/remaining/session flags. An asset or evidence change makes earlier passes **stale**. A later failure supersedes a pass. Rejected candidates remain preserved.

After actually inspecting the evidence, record one stage:

```sh
node <skill>/scripts/creator.mjs review --source <run> --pose waiting --stage visual \
  --expected <pose-fingerprint-from-status> --verdict pass \
  --notes "Both eyes/brows and 11 expression steps inspected; describe limitations" \
  --evidence qa/round-01/waiting/capture.json --evidence qa/round-01/review.html
```

Record failures with `--verdict fail` and the affected candidate evidence. Evidence paths are relative to the run. Attach inspected screenshots/strips or the capture inventory as well as notes; no placeholder pass or automatic self-approval from a test result. To re-review after repair, get the new fingerprint and inspect new captures.

For independently moved layers, recording a `motion` pass also requires valid layer/connection declarations and the inspected per-pose `capture.json` from a successful `--motion --contacts` run bound to the same source fingerprint. A failed or unrelated capture cannot support a pass. This technical prerequisite does not replace visually checking its complete connection crops and the actual app transitions.

`creator.mjs payload` requires current source/layers/visual/motion passes for every selected pose. The low-level payload script exposes the same gate with `--reviewed`; its ungated mode remains for legacy technical callers and does not establish production acceptance. Apply runtime patches to a new source round **before** review rather than changing assets after acceptance.

After export bind the exact archive, then record the run-level `renderer`, `behavior`, `app`, `rights` stages (omit `--pose`, use the reported delivery fingerprint):

```sh
node <skill>/scripts/creator.mjs review --source <run> --package <final.petchar>
node <skill>/scripts/creator.mjs review --source <run>
```

Renderer and behavior evidence must correspond to the bound archive's payload. `app` records actual packaged app/version, import, selection, observed interactions and quit/restart persistence; distinguish real UI coverage from automated input coverage. Coordinate-automation failures are not automatically application bugs. `rights` records sources and unresolved terms; a pass means the review was performed, never that permission was granted. It is valid to record unresolved rights explicitly without claiming distribution clearance.

Complete only when current pose checks and delivery checks pass and the archive is bound. Keep review data and private paths outside distributable packs. Report material visual limits rather than “flawless”. Use fresh delivery versions; never hand off a rejected candidate.

## Working files

Keep all source/candidates, captures, model weights/locations, environment logs and signing data out of Git. Review status is separate from disk usage: report large run size and offer a retention plan. Preserve original/selected/rejected evidence; do not delete it automatically to save space. When resuming older runs, prefer actual selection and artifact evidence over stale free-form progress notes; keep old notes as historical records.
