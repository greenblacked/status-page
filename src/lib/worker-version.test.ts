import { describe, expect, it } from "vitest";
import { withWorkerVersion } from "./worker-version";

describe("withWorkerVersion", () => {
  it("adds X-Worker-Version without dropping the response's status, headers or body", async () => {
    const original = new Response("board", { status: 503, headers: { "Content-Type": "text/plain", "Retry-After": "60" } });
    const tagged = withWorkerVersion(original, "0f6b5b4e-2d0c-4d38-9a6b-3c4f1e2a7b90");
    expect(tagged.status).toBe(503);
    expect(tagged.headers.get("X-Worker-Version")).toBe("0f6b5b4e-2d0c-4d38-9a6b-3c4f1e2a7b90");
    expect(tagged.headers.get("Retry-After")).toBe("60");
    await expect(tagged.text()).resolves.toBe("board");
  });

  it("leaves the response alone when there is no version id", () => {
    const original = new Response("board");
    expect(withWorkerVersion(original, undefined)).toBe(original);
    expect(withWorkerVersion(original, "")).toBe(original);
  });
});
