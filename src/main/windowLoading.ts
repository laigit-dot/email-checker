export interface LoadRetryOptions {
  delayMs?: number;
  retries?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function loadWithRetry(
  load: () => Promise<void>,
  options: LoadRetryOptions = {},
): Promise<void> {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 200;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await load();
      return;
    } catch (reason) {
      if (attempt >= retries) {
        throw reason;
      }
      await delay(delayMs * (attempt + 1));
    }
  }
}
