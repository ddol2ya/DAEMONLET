import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement, ReactNode } from "react"
import { createTranslator } from "../electron/shared/translations"
vi.mock("../src/i18n/useLanguage", () => ({ useT: () => createTranslator("ko") }))
import App from "../src/app/App"
import { DebugPanel } from "../src/app/DebugPanel"
import { FileDropZone } from "../src/app/FileDropZone"

// Exercise App's real option wiring, selection callback and catalog subscription
// with a controlled session. Native packaged UI/PSD loading is checked separately.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[],
  stateIndex: 0, refIndex: 0, mounting: true,
  effects: [] as (() => void | (() => void))[], cleanups: [] as (() => void)[],
}))
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.stateIndex++
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next }]
  },
  useRef(initial: unknown) {
    const index = hooks.refIndex++
    return hooks.refs[index] ?? (hooks.refs[index] = { current: initial })
  },
  useEffect(effect: () => void | (() => void)) { if (hooks.mounting) hooks.effects.push(effect) },
  useCallback<T>(callback: T) { return callback },
}))

const fake = vi.hoisted(() => {
  const state = {
    characterId: "gpichan" as string | null,
    characters: [] as { id: string; label: string; manifestUrl: string }[],
    changed: null as null | ((snapshot: { generation: number }) => void),
    listeners: new Set<() => void>(),
  }
  const diagnostics = () => ({ characterId: state.characterId, anchors: null, rigLayerCount: 8, hairStrandCount: 0, qualityMode: "RIG_ANIMATED", qualityFindings: [], pose: { availablePoses: [] } })
  const runtime = {
    getDiagnostics: diagnostics, getHitAreaResolver: () => null, resize() {},
    subscribe(listener: () => void) { state.listeners.add(listener); return () => state.listeners.delete(listener) },
    loadPsd: vi.fn(async (_file: File) => {
      state.characterId = null; state.listeners.forEach(listener => listener())
      return { model: { rig: { layers: [{ strands: [] }] } } }
    }),
  }
  const loadCharacter = vi.fn(async (id: string, _signal?: AbortSignal) => {
    state.characterId = id; state.listeners.forEach(listener => listener())
  })
  return { state, runtime, loadCharacter }
})
vi.mock("../src/pose/PoseManifest", () => ({ loadCharacterCatalog: vi.fn(async () => ({ characters: fake.state.characters, warnings: [] })) }))
vi.mock("../src/runtime/CharacterSession", () => ({ CharacterSession: class {
  runtime = fake.runtime
  behavior = { subscribe: () => () => {}, getDiagnostics: () => ({}), dispatch() {}, prepareForModelChange() {}, configure() {} }
  dialogue = { subscribe: () => () => {}, getSnapshot: () => null, setAvailable() {}, configure() {} }
  loadCharacter = fake.loadCharacter
  invalidateCatalog() {} connectTaskSource() {} start() {} dispose() {}
} }))

let tree: ReactElement
const render = () => { hooks.stateIndex = hooks.refIndex = 0; tree = App() }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render() }
function component<T>(type: unknown): T {
  const find = (node: ReactNode): ReactElement | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean)
    if (!node || typeof node !== "object" || !("props" in node)) return
    const element = node as ReactElement<{ children?: ReactNode }>
    return element.type === type ? element : find(element.props.children)
  }
  const found = find(tree)
  if (!found) throw Error("Missing component")
  return found.props as T
}
type Panel = { models: { id: string; label: string }[]; selectedModel: string; onSelectModel(value: string): void; diagnostics: { characterId: string | null } }
const panel = () => component<Panel>(DebugPanel)
const select = async (label: string) => {
  const props = panel(), option = props.models.find(model => model.label === label)
  if (!option) throw Error("Missing model option " + label)
  props.onSelectModel(option.id); await flush()
}
const revision = (id: string, version: number) => { fake.state.characters = fake.state.characters.map(c => c.id === id ? { ...c, manifestUrl: `/packs/${id}/${version}/character.json` } : c) }
const catalogChanged = async (generation: number) => { fake.state.changed?.({ generation }); await flush() }

beforeEach(async () => {
  vi.clearAllMocks()
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.cleanups = []; hooks.mounting = true
  fake.state.characterId = "gpichan"; fake.state.listeners.clear()
  fake.state.characters = ["gpichan", "asuma-toki", "asuma-toki-v2", "asuma-toki-v3", "external"].map(id => ({ id, label: id === "external" ? "External ID pack" : id, manifestUrl: `/packs/${id}/1/character.json` }))
  vi.stubGlobal("window", Object.assign(new EventTarget(), { motionLabDesktop: { characters: {
    list: async () => ({ generation: 0 }),
    onChanged(listener: typeof fake.state.changed) { fake.state.changed = listener; return () => { fake.state.changed = null } },
  } } }))
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }))
  render(); hooks.refs[0].current = {} // mounted canvas, supplied to the fake session
  hooks.mounting = false
  hooks.effects.forEach(effect => { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup) })
  await flush(); fake.loadCharacter.mockClear()
})
afterEach(() => { hooks.cleanups.forEach(cleanup => cleanup()); vi.unstubAllGlobals() })

describe("Motion Lab character selection", () => {
  it("gives a valid external pack and loose PSD mode distinct option values", () => {
    const options = panel().models
    expect(new Set(options.map(option => option.id)).size).toBe(options.length)
    expect(options.find(option => option.label === "External ID pack")!.id).not.toBe(options.find(option => option.label === "External PSD")!.id)
  })
  it("passes the original external ID to the actual App session callback", async () => {
    await select("External ID pack")
    expect(fake.loadCharacter).toHaveBeenCalledExactlyOnceWith("external", expect.any(AbortSignal))
    expect(panel().diagnostics.characterId).toBe("external")
  })
  it("reloads external on update and rollback while preserving its identity", async () => {
    await select("External ID pack"); fake.loadCharacter.mockClear()
    revision("external", 2); await catalogChanged(1)
    expect(fake.loadCharacter).toHaveBeenCalledExactlyOnceWith("external", expect.any(AbortSignal))
    fake.loadCharacter.mockClear(); revision("external", 1); await catalogChanged(2)
    expect(fake.loadCharacter).toHaveBeenCalledExactlyOnceWith("external", expect.any(AbortSignal))
  })
  it("does not reload the selected character when only another manifest changes", async () => {
    revision("external", 2); await catalogChanged(1)
    expect(fake.loadCharacter).not.toHaveBeenCalled()
    expect(panel().diagnostics.characterId).toBe("gpichan")
  })
  it("keeps a directly opened PSD active when another pack is installed", async () => {
    await component<{ onFile(file: File): Promise<void> }>(FileDropZone).onFile(new File(["fixture"], "loose.psd")); await flush()
    expect(fake.runtime.loadPsd).toHaveBeenCalledOnce()
    const looseOption = panel().models.find(option => option.label === "External PSD")!
    expect(panel().selectedModel).toBe(looseOption.id)
    fake.state.characters.push({ id: "another-pack", label: "Another pack", manifestUrl: "/packs/another/1/character.json" })
    await catalogChanged(1)
    expect(fake.loadCharacter).not.toHaveBeenCalled()
    expect(panel().diagnostics.characterId).toBeNull()
    expect(panel().selectedModel).toBe(looseOption.id)
    expect(panel().models.some(option => option.label === "Another pack")).toBe(true)
  })
  it.each(["gpichan", "asuma-toki", "asuma-toki-v2", "asuma-toki-v3"])("can leave loose PSD mode for %s", async id => {
    await select("External PSD")
    expect(fake.loadCharacter).not.toHaveBeenCalled()
    await select(id)
    expect(fake.loadCharacter).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal))
    expect(panel().diagnostics.characterId).toBe(id)
  })
})
