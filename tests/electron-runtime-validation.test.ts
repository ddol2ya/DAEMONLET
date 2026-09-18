import { describe, expect, it } from "vitest"
import { validatePetReadyInfo, validateProtocolClientCommand } from "../electron/shared/runtime-validation"

describe("Electron IPC runtime validation", () => {
  it("accepts only Protocol v1 client commands", () => {
    expect(validateProtocolClientCommand({ protocolVersion: 1, commandType: "client.hello", requestId: "r", clientId: "pet", supportedProtocolVersions: [1] })).not.toBeNull()
    expect(validateProtocolClientCommand({ protocolVersion: 1, commandType: "snapshot.request", requestId: "r", reason: "initial" })).not.toBeNull()
    expect(validateProtocolClientCommand({ protocolVersion: 1, commandType: "client.ping", requestId: "r", sentAt: 1 })).not.toBeNull()
  })

  it("rejects server frames, injection fields, and invalid ready reports", () => {
    expect(validateProtocolClientCommand({ protocolVersion: 1, frameType: "event", requestId: "r" })).toBeNull()
    expect(validateProtocolClientCommand({ protocolVersion: 1, commandType: "snapshot.request", requestId: "r", reason: "initial", endpoint: "ws://evil" })).toBeNull()
    const ready = { webgl: true, characterId: "gpichan", revision: "builtin", firstFrameAt: 1, ticket: { id: "gpichan", revision: "builtin", requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", rendererGeneration: 1 } }
    expect(validatePetReadyInfo(ready)).toEqual(ready)
    expect(validatePetReadyInfo({ webgl: true, characterId: "gpichan", firstFrameAt: 1 })).toBeNull()
    expect(validatePetReadyInfo({ webgl: false, characterId: "gpichan", firstFrameAt: 1 })).toBeNull()
  })
})
