import { ModifierDragController } from "../../src/pet/ModifierDragController"
const canvas = document.querySelector("canvas")!
const desktop = window.petDesktop!
const context = canvas.getContext("2d")!
context.fillStyle = "#609060"; context.fillRect(20, 20, 100, 100)
const state = { ordinaryDowns: 0, locked: false, begins: 0, pointerModifiers: [] as unknown[] }
Object.assign(window, { dragSmoke: state })
new ModifierDragController(canvas, {
  platform: desktop.platform, allowed: () => true,
  // Deterministic painted rectangle, not the character renderer's alpha sampler.
  hit: (x, y) => x >= 20 && x < 120 && y >= 20 && y < 120,
  request: value => { if (value.action === "begin") state.begins++; return desktop.dragWindow(value) },
  lock: active => { state.locked = active; desktop.setInteractionLocked(active) },
})
canvas.addEventListener("pointerdown", () => { state.ordinaryDowns++ })
window.addEventListener("pointerdown", event => state.pointerModifiers.push({ alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, altGraph: event.getModifierState("AltGraph") }), true)
