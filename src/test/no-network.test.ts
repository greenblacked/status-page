import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

// The guard src/test/no-network.ts puts in front of fetch for every unit test (vitest.config.ts, setupFiles).

describe("the unit tests' network guard", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("refuses a request to another host, naming it", async () => {
    await expect(fetch("https://example.com/status.json")).rejects.toThrow(
      new TypeError("unit tests must not reach the network: example.com"),
    );
    await expect(fetch(new URL("https://status.example.org/"))).rejects.toThrow(/: status\.example\.org$/);
    await expect(fetch(new Request("http://10.0.0.1:8080/"))).rejects.toThrow(/: 10\.0\.0\.1$/);
  });

  it("lets a request to this machine through", async () => {
    server = createServer((_req, res) => res.end("local"));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("local");
  });

  it("gives way to a stub, and is back once the stub is undone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("stubbed")),
    );
    expect(await (await fetch("https://example.com/")).text()).toBe("stubbed");

    vi.unstubAllGlobals();
    await expect(fetch("https://example.com/")).rejects.toThrow(/must not reach the network/);
  });
});
