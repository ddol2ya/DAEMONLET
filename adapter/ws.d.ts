declare module "ws" {
  import { EventEmitter } from "node:events"
  import type { IncomingMessage, Server } from "node:http"
  import type { AddressInfo } from "node:net"

  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export class WebSocket extends EventEmitter {
    constructor(url: string, options?: { origin?: string; localAddress?: string; maxPayload?: number; perMessageDeflate?: boolean; handshakeTimeout?: number })
    static readonly OPEN: number
    static readonly CLOSING: number
    readonly readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    terminate(): void
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this
    on(event: "error", listener: (error: Error) => void): this
    once(event: "close", listener: (code: number, reason: Buffer) => void): this
    once(event: string, listener: (...args: any[]) => void): this
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: {
      server?: Server
      host?: string
      port?: number
      path?: string
      maxPayload?: number
      verifyClient?: (
        info: { origin: string; secure: boolean; req: IncomingMessage },
        done: (result: boolean, code?: number, name?: string, headers?: Record<string, string>) => void,
      ) => void
    })
    readonly clients: Set<WebSocket>
    address(): AddressInfo | string | null
    close(callback?: (error?: Error) => void): void
    on(event: "connection", listener: (socket: WebSocket) => void): this
    once(event: "connection", listener: (socket: WebSocket) => void): this
    once(event: "listening", listener: () => void): this
    once(event: "error", listener: (error: Error) => void): this
  }
}
