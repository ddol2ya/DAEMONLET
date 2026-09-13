// ComfyUI API graph authored for the Daemonlet production pipeline.
export function makeSeeThroughPrompt(image, seed, filenamePrefix, profile) {
  return {
    "1": { class_type: "LoadImage", inputs: { image: image.subfolder ? `${image.subfolder}/${image.name}` : image.name } },
    "2": { class_type: "SeeThrough_LoadLayerDiffModel", inputs: { model: "layerdifforg/seethroughv0.0.2_layerdiff3d", vae_ckpt: "", unet_ckpt: "", quant_mode: "none", cache_tag_embeds: true, group_offload: profile.groupOffload, auto_download: false } },
    "3": { class_type: "SeeThrough_LoadDepthModel", inputs: { model: "layerdifforg/seethroughv0.0.1_marigold", quant_mode: "none", cache_tag_embeds: true, group_offload: profile.groupOffload, auto_download: false } },
    "4": { class_type: "SeeThrough_GenerateLayers", inputs: { image: ["1", 0], layerdiff_model: ["2", 0], seed, resolution: profile.resolution, num_inference_steps: 30 } },
    "5": { class_type: "SeeThrough_GenerateDepth", inputs: { layers: ["4", 0], depth_model: ["3", 0], seed: (seed + 1) >>> 0, resolution_depth: profile.depthResolution } },
    "6": { class_type: "SeeThrough_PostProcess", inputs: { layers_depth: ["5", 0], tblr_split: true, use_lama: false } },
    "7": { class_type: "SeeThrough_SavePSD", inputs: { parts: ["6", 0], filename_prefix: `${filenamePrefix}_seed_${seed}` } },
    "8": { class_type: "PreviewImage", inputs: { images: ["6", 1] } },
  }
}

