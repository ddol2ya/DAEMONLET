import { WebSocket } from "ws"
import { CharacterEventProtocolClient } from "../../../src/protocol/CharacterEventProtocolClient"
import { MAX_PROTOCOL_MESSAGE_BYTES } from "../../../src/protocol/types"
import { WebSocketProtocolTransport, type WebSocketFactory } from "../../../src/protocol/transports/WebSocketProtocolTransport"

export function createActivityClient(endpoint: string): CharacterEventProtocolClient {
  const factory: WebSocketFactory = url => {
    const socket = new WebSocket(url, { maxPayload: MAX_PROTOCOL_MESSAGE_BYTES, perMessageDeflate: false, handshakeTimeout: 5000 })
    // ws can emit an error when a CONNECTING socket is disposed after its handlers detach.
    socket.on("error", () => {})
    return socket as unknown as ReturnType<WebSocketFactory>
  }
  return new CharacterEventProtocolClient(new WebSocketProtocolTransport(endpoint, { factory }), { clientId: "daemonlet-activity", traceLimit: 1 })
}
