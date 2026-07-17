import { describe, expect, it, vi } from "vitest"
import { CollectorServer } from "../../src/collector/server.js"
import { createCollectorFixture } from "../helpers/factories.js"

describe("collector binding", () => {
  it("binds an OS-selected loopback port within two seconds", async () => {
    const fixture = await createCollectorFixture()
    const started = Date.now()
    const collector = await fixture.start()
    expect(["127.0.0.1", "::1"]).toContain(collector.host)
    expect(collector.port).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(2_000)
    await collector.close()
  })

  it("returns the same ready handle and closes idempotently", async () => {
    const fixture = await createCollectorFixture()
    const first = await fixture.start()
    expect(await fixture.start()).toBe(first)
    await first.close()
    await first.close()
  })

  it("uses a closed default route and contains asynchronous handler failures", async () => {
    const fallback = new CollectorServer()
    const first = await fallback.start()
    const missing = await fetch(`http://${first.host}:${first.port}/missing`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } })
    await fallback.close()

    const failing = new CollectorServer(async () => {
      throw new Error("fixture")
    })
    const second = await failing.start()
    const internal = await fetch(`http://${second.host}:${second.port}/failure`)
    expect(internal.status).toBe(500)
    expect(await internal.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } })
    await failing.close()
  })

  it("reports a listener failure once and rejects overlapping starts", async () => {
    const onFailure = vi.fn().mockResolvedValue(undefined)
    const server = new CollectorServer(undefined, onFailure)
    const internal = server as unknown as {
      state: "stopped" | "starting" | "ready" | "draining" | "failed"
      reportFailure(reason: string): Promise<void>
    }
    await internal.reportFailure("listener-error")
    await internal.reportFailure("unexpected-close")
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(server.status).toBe("failed")

    internal.state = "starting"
    await expect(server.start()).rejects.toMatchObject({ code: "COLLECTOR_EXISTS" })
    await server.close()
    expect(server.status).toBe("stopped")
  })

  it("falls back to IPv6 only for unsupported IPv4 loopback errors", async () => {
    const server = new CollectorServer()
    const handle = Object.freeze({
      id: "collector_fixture",
      host: "::1" as const,
      port: 12345,
      status: "ready" as const,
      close: vi.fn().mockResolvedValue(undefined),
    })
    const unsupported = Object.assign(new Error("unsupported"), { code: "EAFNOSUPPORT" })
    const bind = vi
      .spyOn(server as unknown as { bind(host: "127.0.0.1" | "::1"): Promise<typeof handle> }, "bind")
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce(handle)

    await expect(server.start()).resolves.toBe(handle)
    expect(bind).toHaveBeenNthCalledWith(1, "127.0.0.1")
    expect(bind).toHaveBeenNthCalledWith(2, "::1")
  })

  it("reports direct and fallback loopback bind failures", async () => {
    const direct = new CollectorServer()
    vi.spyOn(direct as unknown as { bind(host: "127.0.0.1" | "::1"): Promise<never> }, "bind").mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    )
    await expect(direct.start()).rejects.toMatchObject({ code: "LOOPBACK_BIND_FAILED" })
    expect(direct.status).toBe("failed")

    const fallback = new CollectorServer()
    vi.spyOn(fallback as unknown as { bind(host: "127.0.0.1" | "::1"): Promise<never> }, "bind")
      .mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "EADDRNOTAVAIL" }))
      .mockRejectedValueOnce(new Error("ipv6 unavailable"))
    await expect(fallback.start()).rejects.toMatchObject({ code: "LOOPBACK_BIND_FAILED" })
    expect(fallback.status).toBe("failed")
  })

  it("closes a ready collector whose listener disappeared before teardown", async () => {
    const server = new CollectorServer()
    const internal = server as unknown as {
      state: "stopped" | "starting" | "ready" | "draining" | "failed"
      server: undefined
    }
    internal.state = "ready"
    internal.server = undefined

    await expect(server.close()).resolves.toBeUndefined()
    expect(server.status).toBe("stopped")
  })
})
