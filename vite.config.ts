import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { resolve } from "node:path"
import { pruneRuntimeAssets } from "./scripts/release/runtime-assets.mjs"
import { writeLicenseBundle } from "./scripts/release/licenses.mjs"

let characterOutputDirectory = resolve(import.meta.dirname, "dist/characters")

export default defineConfig({
  plugins: [react(), {
    name: "active-character-assets",
    apply: "build",
    configResolved(config) {
      characterOutputDirectory = resolve(config.root, config.build.outDir, "characters")
    },
    async closeBundle() {
      await pruneRuntimeAssets(characterOutputDirectory)
    },
    async generateBundle() {
      await writeLicenseBundle(resolve(characterOutputDirectory, "../licenses"), [...this.getModuleIds()])
    },
  }],
  server: {
    host: "127.0.0.1",
  },
  build: {
    rollupOptions: {
      input: {
        lab: resolve(import.meta.dirname, "index.html"),
        pet: resolve(import.meta.dirname, "pet.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
        activity: resolve(import.meta.dirname, "activity.html"),
        activityBubble: resolve(import.meta.dirname, "activity-bubble.html"),
        sideChat: resolve(import.meta.dirname, "side-chat.html"),
        speechBubble: resolve(import.meta.dirname, "speech-bubble.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
})
