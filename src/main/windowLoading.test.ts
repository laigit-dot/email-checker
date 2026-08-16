import { describe, expect, it, vi } from "vitest";

import { loadWithRetry } from "./windowLoading.js";

describe("loadWithRetry", () => {
  it("retries a transient renderer load failure", async () => {
    const load = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("ERR_FAILED"))
      .mockResolvedValueOnce();

    await expect(
      loadWithRetry(load, { delayMs: 0, retries: 2 }),
    ).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("surfaces the final renderer load failure", async () => {
    const failure = new Error("renderer unavailable");
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(failure);

    await expect(
      loadWithRetry(load, { delayMs: 0, retries: 2 }),
    ).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
