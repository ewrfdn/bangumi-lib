/**
 * Minimal ambient declaration for ws@8.22.1.
 *
 * `ws` is installed (as a transitive dependency) but ships no types and
 * `@types/ws` is deliberately not added just for the chat gateway. This file
 * describes only the surface server code and tests use; extend it when a new
 * consumer genuinely needs more of the API.
 */
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'

  /** Payload of a `message` event; ws@8 defaults to Buffer, or Buffer[] for fragments. */
  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export interface WebSocketServerOptions {
    noServer?: boolean
    maxPayload?: number
    clientTracking?: boolean
    perMessageDeflate?: boolean
  }

  export class WebSocket {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3

    readonly readyState: number
    readonly url: string
    readonly protocol: string
    readonly bufferedAmount: number

    constructor(address: string | URL, protocols?: string | string[], options?: Record<string, unknown>)

    send(data: string | Buffer | ArrayBuffer | Buffer[], callback?: (error?: Error) => void): void
    close(code?: number, reason?: string | Buffer): void
    terminate(): void
    ping(data?: Buffer, mask?: boolean, callback?: () => void): void
    pong(data?: Buffer, mask?: boolean, callback?: () => void): void

    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'open', listener: () => void): this
    on(event: 'ping' | 'pong', listener: (data: Buffer) => void): this
    on(event: string, listener: (...args: any[]) => void): this
    once(event: string, listener: (...args: any[]) => void): this
    off(event: string, listener: (...args: any[]) => void): this
    removeListener(event: string, listener: (...args: any[]) => void): this
    removeAllListeners(event?: string): this
    emit(event: string, ...args: any[]): boolean
  }

  export class WebSocketServer {
    constructor(options?: WebSocketServerOptions)

    readonly clients: Set<WebSocket>
    readonly options: WebSocketServerOptions

    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void,
    ): void
    close(callback?: (error?: Error) => void): void
    shouldHandle(request: IncomingMessage): boolean

    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'close', listener: () => void): this
    on(event: 'listening', listener: () => void): this
    on(event: string, listener: (...args: any[]) => void): this
    once(event: string, listener: (...args: any[]) => void): this
    off(event: string, listener: (...args: any[]) => void): this
    emit(event: string, ...args: any[]): boolean
  }

  export default WebSocket
}
