import { describe, expect, it, vi } from "vitest";

import { ApprovalQueue } from "./ApprovalQueue";

describe("ApprovalQueue", () => {
  it("runs approval requests sequentially", async () => {
    const queue = new ApprovalQueue();
    const signal = new AbortController().signal;
    const events: string[] = [];

    let resolveFirst: ((value: boolean) => void) | undefined;
    const first = queue.requestApproval(async () => {
      events.push("first:start");
      return await new Promise<boolean>((resolve) => {
        resolveFirst = resolve;
      });
    }, signal);

    const second = queue.requestApproval(async () => {
      events.push("second:start");
      return true;
    }, signal);

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    resolveFirst?.(true);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(events).toEqual(["first:start", "second:start"]);
  });

  it("continues after a rejected approval request", async () => {
    const queue = new ApprovalQueue();
    const signal = new AbortController().signal;
    const events: string[] = [];

    const first = queue.requestApproval(async () => {
      events.push("first:start");
      throw new Error("boom");
    }, signal);

    const second = queue.requestApproval(async () => {
      events.push("second:start");
      return true;
    }, signal);

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe(true);
    expect(events).toEqual(["first:start", "second:start"]);
  });

  it("passes the abort signal through the confirm closure", async () => {
    const queue = new ApprovalQueue();
    const signal = new AbortController().signal;
    const confirm = vi.fn(async (_opts?: { signal?: AbortSignal }) => true);

    await expect(queue.requestApproval(() => confirm({ signal }), signal)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith({ signal });
  });

  it("does not call confirm when already aborted", async () => {
    const queue = new ApprovalQueue();
    const controller = new AbortController();
    controller.abort();
    const confirm = vi.fn(async (_opts?: { signal?: AbortSignal }) => true);

    await expect(queue.requestApproval(() => confirm({ signal: controller.signal }), controller.signal)).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
