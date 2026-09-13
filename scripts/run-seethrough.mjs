#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { makeSeeThroughPrompt } from "./seethrough-workflow.mjs"
import { seethroughProfile } from "./seethrough-profile.mjs"

const [
  inputPath,
  outputDirectory,
  seedsArgument = "42013",
  baseUrl = "http://127.0.0.1:8188",
  filenamePrefix = "pose",
  resolutionArgument = "1280",
  stepsArgument = "30",
  vramArgument,
] = process.argv.slice(2)
if (!inputPath || !outputDirectory) {
  console.error("Usage: node scripts/run-seethrough.mjs <input.png> <output-dir> [seeds=42013] [comfy-url] [filename-prefix] [resolution=1280] [steps=30] [vram-GiB=auto]")
  process.exit(2)
}

const seeds = seedsArgument.split(",").map(Number)
if (!seeds.length || seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error("Seeds must be comma-separated uint32 integers")
const requestedResolution = Number(resolutionArgument)
const steps = Number(stepsArgument)
if (!Number.isInteger(requestedResolution) || requestedResolution < 256 || requestedResolution > 4096) throw new Error("Resolution must be an integer from 256 to 4096")
if (!Number.isInteger(steps) || steps < 1 || steps > 200) throw new Error("Steps must be an integer from 1 to 200")
const comfy = baseUrl.replace(/\/$/, "")
const clientId = `daemonlet-${crypto.randomUUID()}`
let vramGiB = vramArgument === undefined ? null : Number(vramArgument)
if (vramGiB !== null && (!Number.isFinite(vramGiB) || vramGiB <= 0)) throw new Error("VRAM must be a positive GiB number")
if (vramGiB === null) {
  try {
    const stats = await (await checked(await fetch(`${comfy}/system_stats`), "ComfyUI system stats")).json()
    const device = stats.devices?.find(candidate => candidate.type === "cuda")
    if (device?.vram_total > 0) vramGiB = device.vram_total / 1024 ** 3
  } catch { /* Unknown hardware remains visible in the summary. */ }
}
const profile = seethroughProfile(requestedResolution, vramGiB)
const { resolution } = profile
if (profile.warning) console.warn(profile.warning)
const objectInfo = await (await checked(await fetch(`${comfy}/object_info`), "ComfyUI node definitions")).json()
const required = ['SeeThrough_LoadLayerDiffModel','SeeThrough_LoadDepthModel','SeeThrough_GenerateLayers','SeeThrough_GenerateDepth','SeeThrough_PostProcess','SeeThrough_SavePSD']
const missing = required.filter(name => !objectInfo[name])
if (missing.length) throw new Error('Compatible See-through nodes are missing: '+missing.join(', ')+'. Install the documented version before uploading a reference.')
for (const name of required.slice(0,2)) {
  const inputs = {...objectInfo[name].input?.required,...objectInfo[name].input?.optional}
  if (!inputs.group_offload || !inputs.auto_download) throw new Error(name+' lacks group_offload/auto_download. Check the documented See-through version.')
}
const currentQueue = await (await checked(await fetch(`${comfy}/queue`), "ComfyUI queue")).json()
if (currentQueue.queue_running?.length || currentQueue.queue_pending?.length) throw new Error("ComfyUI has active jobs. Retry after the existing queue finishes.")

async function checked(response, label) {
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${await response.text()}`)
  return response
}

async function uploadInput() {
  const data = await readFile(inputPath)
  const form = new FormData()
  const remoteName = `daemonlet-${filenamePrefix}-${Date.now()}.png`
  form.append("image", new Blob([data], { type: "image/png" }), remoteName)
  form.append("overwrite", "false")
  const response = await checked(await fetch(`${comfy}/upload/image`, { method: "POST", body: form }), "ComfyUI input upload")
  return response.json()
}

function prompt(image, seed) {
  const graph=makeSeeThroughPrompt(image,seed,filenamePrefix,profile)
  graph['4'].inputs.num_inference_steps=steps
  return graph
}

async function queue(image, seed) {
  const response = await checked(await fetch(`${comfy}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, prompt: prompt(image, seed) }),
  }), "ComfyUI prompt")
  const value = await response.json()
  if (!value.prompt_id) throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(value)}`)
  return value.prompt_id
}

async function waitForHistory(promptId) {
  const deadline = Date.now() + 20 * 60 * 1000
  let peakVramBytes = 0
  let vramSamples = 0
  while (Date.now() < deadline) {
    try {
      const statsResponse = await checked(await fetch(`${comfy}/system_stats`), "ComfyUI system stats")
      const stats = await statsResponse.json()
      const device = stats.devices?.find((candidate) => candidate.type === "cuda")
      if (device && Number.isFinite(device.vram_total) && Number.isFinite(device.vram_free)) {
        peakVramBytes = Math.max(peakVramBytes, device.vram_total - device.vram_free)
        vramSamples++
      }
    } catch {
      // A missing transient stats sample must not fail an otherwise valid generation.
    }
    const response = await checked(await fetch(`${comfy}/history/${encodeURIComponent(promptId)}`), "ComfyUI history")
    const history = await response.json()
    const entry = history[promptId]
    if (entry?.status?.status_str === "error" || entry?.status?.completed === false && entry?.status?.messages?.some((message) => message[0] === "execution_error")) {
      throw new Error(`See-through ${promptId} failed: ${JSON.stringify(entry.status.messages)}`)
    }
    if (entry?.status?.completed) return { entry, peakVramBytes, vramSamples }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`See-through ${promptId} timed out`)
}

async function downloadOutput(filename, destination, type = "output", subfolder = "") {
  const url = new URL(`${comfy}/view`)
  url.searchParams.set("filename", filename)
  url.searchParams.set("type", type)
  if (subfolder) url.searchParams.set("subfolder", subfolder)
  const response = await checked(await fetch(url), `download ${filename}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function downloadResult(seed, entry) {
  const directory = join(outputDirectory, `seed-${seed}`)
  await mkdir(directory, { recursive: true })
  const infoPath = entry.outputs?.["7"]?.text?.[0]
  let infoFilename = infoPath ? basename(String(infoPath).replaceAll("\\", "/")) : ""
  if (!infoFilename) {
    const log = await checked(await fetch(`${comfy}/view?filename=seethrough_psd_info.log&type=output`), "See-through info log")
    infoFilename = (await log.text()).trim()
  }
  await downloadOutput(infoFilename, join(directory, "layers.json"))
  const metadata = JSON.parse(await readFile(join(directory, "layers.json"), "utf8"))
  for (const layer of metadata.layers) {
    await downloadOutput(layer.filename, join(directory, layer.filename))
    if (layer.depth_filename) await downloadOutput(layer.depth_filename, join(directory, layer.depth_filename))
  }
  const preview = entry.outputs?.["8"]?.images?.[0]
  if (preview) await downloadOutput(preview.filename, join(directory, "preview.png"), preview.type, preview.subfolder)
  console.log(`Downloaded seed ${seed}: ${metadata.layers.length} layers`)
  return {
    layerCount: metadata.layers.length,
    psdWidth: metadata.width,
    psdHeight: metadata.height,
    previewDownloaded: Boolean(preview),
  }
}

await mkdir(outputDirectory, { recursive: true })
const image = await uploadInput()
const summaries = []
for (const seed of seeds) {
  console.log(`Queueing See-through seed ${seed} at ${resolution}px / ${steps} steps`)
  const startedAt = Date.now()
  const promptId = await queue(image, seed)
  console.log(`Running ${promptId}`)
  const { entry, peakVramBytes, vramSamples } = await waitForHistory(promptId)
  const result = await downloadResult(seed, entry)
  const elapsedMs = Date.now() - startedAt
  summaries.push({ seed, depthSeed: (seed + 1) >>> 0, resolution, steps, promptId, elapsedMs, peakVramBytes, peakVramMiB: Math.round(peakVramBytes / 1024 / 1024), vramSamples, ...result })
  console.log(`Completed seed ${seed} at ${resolution}px in ${(elapsedMs / 1000).toFixed(1)}s`)
}
await writeFile(join(outputDirectory, "run-summary.json"), `${JSON.stringify({ input: basename(inputPath), filenamePrefix, requestedResolution, vramGiB, requestedProfile: profile, offloadActivation: "verify in ComfyUI logs; a requested flag alone is not proof", runs: summaries }, null, 2)}\n`)
