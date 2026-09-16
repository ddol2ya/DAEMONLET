/** Metadata-only doubles for the QA entry. Never a production dependency. */
export const preparationFixture = { detected: "/official/B", connections: [] as string[], stops: 0 }
const waiting: Array<Promise<void>> = []
export function holdNextPreparation() {
  let release!: () => void
  waiting.push(new Promise<void>(done => { release = done }))
  return release
}
export async function inspectSideChatRuntime(executable?: string | null) {
  return { executable: executable ?? preparationFixture.detected, runtime: { version: "0.154.0" } }
}
export async function connectVerifiedSideChat(options: { executable: string }) {
  preparationFixture.connections.push(options.executable)
  await waiting.shift()
  return { stop: async () => { preparationFixture.stops++ } }
}
