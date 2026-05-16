export async function retry(fn, { attempts = 3, delayMs = 1500, onRetry } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        onRetry?.(error, attempt);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
