import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { LIMITS } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"

export type CollectorStatus = "stopped" | "starting" | "ready" | "draining" | "failed"
export type CollectorRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  status: () => "ready" | "draining",
) => void | Promise<void>

export type CollectorHandle = Readonly<{
  id: string
  host: "127.0.0.1" | "::1"
  port: number
  status: "ready"
  close(): Promise<void>
}>

export class CollectorServer {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private state: CollectorStatus = "stopped"
  private handle: CollectorHandle | undefined
  private failureReported = false

  constructor(
    private readonly handler: CollectorRequestHandler = (_request, response) => {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      response.end('{"ok":false,"error":{"code":"NOT_FOUND","message":"Not found","retryable":false}}')
    },
    private readonly onFailure?: (reason: string) => void | Promise<void>,
  ) {}

  async start(): Promise<CollectorHandle> {
    if (this.handle !== undefined && this.state === "ready") return this.handle
    if (this.state !== "stopped") throw new DebugModeError("COLLECTOR_EXISTS", "A collector already exists")
    this.state = "starting"
    try {
      this.handle = await this.bind("127.0.0.1")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") {
        this.state = "failed"
        throw new DebugModeError("LOOPBACK_BIND_FAILED", "The IPv4 loopback collector could not bind")
      }
      try {
        this.handle = await this.bind("::1")
      } catch {
        this.state = "failed"
        throw new DebugModeError("LOOPBACK_BIND_FAILED", "Neither loopback address could bind")
      }
    }
    this.state = "ready"
    return this.handle
  }

  get status(): CollectorStatus {
    return this.state
  }

  async close(): Promise<void> {
    if (this.state === "stopped") return
    this.state = "draining"
    const server = this.server
    if (server === undefined) {
      this.state = "stopped"
      return
    }
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          for (const socket of this.sockets) socket.destroy()
          server.closeAllConnections?.()
          resolve()
        }, 1_000),
      ),
    ])
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server = undefined
    this.handle = undefined
    this.state = "stopped"
  }

  private bind(host: "127.0.0.1" | "::1"): Promise<CollectorHandle> {
    return new Promise((resolve, reject) => {
      const server = createServer(
        {
          requestTimeout: 5_000,
          headersTimeout: 5_000,
          keepAliveTimeout: 1_000,
          maxHeaderSize: 16_384,
          connectionsCheckingInterval: 1_000,
        },
        (request, response) => {
          void Promise.resolve(
            this.handler(request, response, () => (this.state === "draining" ? "draining" : "ready")),
          ).catch(() => {
            if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" })
            response.end('{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Request failed","retryable":false}}')
          })
        },
      )
      server.maxHeadersCount = 32
      this.server = server
      server.on("connection", (socket) => {
        this.sockets.add(socket)
        socket.once("close", () => this.sockets.delete(socket))
      })
      const startupTimeout = setTimeout(() => {
        cleanupStartup()
        server.close()
        const error = new Error("Collector startup timed out") as NodeJS.ErrnoException
        error.code = "ETIMEDOUT"
        reject(error)
      }, LIMITS.collectorReadyMs)
      const startupError = (error: Error) => {
        cleanupStartup()
        server.close()
        reject(error)
      }
      const listening = () => {
        cleanupStartup()
        const address = server.address()
        if (address === null || typeof address === "string") {
          reject(new Error("Collector returned no TCP address"))
          return
        }
        const handle: CollectorHandle = Object.freeze({
          id: `collector_${randomBytes(16).toString("base64url")}`,
          host,
          port: address.port,
          status: "ready" as const,
          close: () => this.close(),
        })
        server.on("error", () => void this.reportFailure("listener-error"))
        server.on("close", () => {
          if (this.state === "ready") void this.reportFailure("unexpected-close")
        })
        resolve(handle)
      }
      const cleanupStartup = () => {
        clearTimeout(startupTimeout)
        server.off("error", startupError)
        server.off("listening", listening)
      }
      server.once("error", startupError)
      server.once("listening", listening)
      server.listen({ host, port: 0, exclusive: true })
    })
  }

  private async reportFailure(reason: string): Promise<void> {
    if (this.failureReported) return
    this.failureReported = true
    this.state = "failed"
    await this.onFailure?.(reason)
  }
}
