export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();

  requestApproval(confirm: () => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    const result = this.tail.then(
      async () => {
        if (signal?.aborted) {
          return false;
        }

        return confirm();
      },
      async () => {
        if (signal?.aborted) {
          return false;
        }

        return confirm();
      },
    );

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}
