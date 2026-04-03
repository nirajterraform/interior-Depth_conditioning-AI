type GeminiRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const e = error as {
    status?: number;
    code?: number;
    message?: string;
    error?: {
      code?: number;
      message?: string;
      status?: string;
    };
  };

  const statusCode = e.status ?? e.code ?? e.error?.code;

  const combinedMessage = `${e.message || ""} ${e.error?.message || ""}`.toLowerCase();

  if (statusCode === 429) return true;

  return (
    combinedMessage.includes("quota") ||
    combinedMessage.includes("rate limit") ||
    combinedMessage.includes("resource exhausted") ||
    combinedMessage.includes("too many requests") ||
    combinedMessage.includes("429")
  );
}

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);

  // jitter to avoid thundering herd
  const jitter = Math.floor(Math.random() * 300);

  return capped + jitter;
}

export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  options: GeminiRetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 4,
    baseDelayMs = 1200,
    maxDelayMs = 8000,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const retryable = isRetryableGeminiError(error);
      const hasMoreAttempts = attempt <= maxRetries;

      if (!retryable || !hasMoreAttempts) {
        throw error;
      }

      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs);

      console.warn(
        `Gemini retryable error detected. attempt=${attempt}/${maxRetries}, waiting ${delay}ms`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}