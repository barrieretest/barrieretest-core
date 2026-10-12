/**
 * Transport plumbing shared by the chat-completions and Anthropic messages
 * wire formats: timeout plus abort, one bounded retry, HTTP error mapping,
 * and base64 image encoding.
 *
 * Request bodies, headers and API keys are never logged or included in error
 * messages; errors carry the HTTP status and a truncated response body only.
 */

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Max response body characters included in an HTTP error message. */
const MAX_ERROR_BODY_CHARS = 500;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_JITTER_MS = 500;
const UNREADABLE_BODY = "<unreadable response body>";

export interface TransportRequest {
  /** Provider label used in error messages, e.g. "Mistral". */
  label: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  /** Caller abort signal, honoured alongside the timeout. */
  signal?: AbortSignal;
}

/** One completed exchange: the body is already consumed, so nothing can stall. */
interface TransportResult {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * POSTs JSON with a timeout, retrying once on 429 and 5xx. Resolves with the
 * response body text of an ok response; a failed request becomes an Error
 * naming the provider.
 */
export async function fetchWithTimeoutAndRetry(request: TransportRequest): Promise<string> {
  let result = await postOnce(request);

  if (isRetryableStatus(result.status)) {
    await delayBeforeRetry(RETRY_BASE_DELAY_MS + Math.random() * RETRY_JITTER_MS, request.signal);
    result = await postOnce(request);
  }

  if (!result.ok) {
    throw new Error(
      `${request.label} API error: ${result.status} - ${result.text.slice(0, MAX_ERROR_BODY_CHARS)}`
    );
  }

  return result.text;
}

/**
 * Timer and abort forwarding cover the whole exchange, body included: a server
 * that sends headers and then stalls still hits the timeout.
 */
async function postOnce(request: TransportRequest): Promise<TransportResult> {
  const { label, url, headers, body, timeoutMs, signal } = request;

  // A request the caller already cancelled is never sent.
  if (signal?.aborted) {
    throw abortReason(signal);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);

  signal?.addEventListener("abort", forwardAbort, { once: true });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = response.ok
      ? await readBody(response, controller.signal)
      : await readErrorBody(response, controller.signal);

    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** 429 and 5xx are transient; every other 4xx is a request the retry cannot fix. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Consumes the body through its own reader so an abort can cancel it; the
 * `Response.text()` promise cannot be cancelled once it holds the lock.
 */
async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  const stream = response.body;
  if (!stream) {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    return await response.text();
  }

  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  // `cancel()` closes the stream but keeps the reader's lock, so the lock has
  // to be released explicitly; `releaseLock()` can still throw while a read is
  // pending, hence the guard.
  const releaseReader = () => {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  };

  if (signal.aborted) {
    cancel();
    releaseReader();
    throw abortReason(signal);
  }
  signal.addEventListener("abort", cancel, { once: true });

  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    releaseReader();
  }

  // A cancelled read resolves as done, so the abort has to be reported here.
  if (signal.aborted) {
    throw abortReason(signal);
  }
  return text;
}

/** An error response is still worth reporting when its body cannot be read. */
async function readErrorBody(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await readBody(response, signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return UNREADABLE_BODY;
  }
}

/** Waits out the backoff, but gives up as soon as the caller aborts. */
function delayBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  const pending = signal;
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(elapsed, ms);
    pending.addEventListener("abort", onAbort, { once: true });

    function elapsed() {
      pending.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timeoutId);
      reject(abortReason(pending));
    }
  });
}

/** Keeps the caller's own abort error instead of inventing a new one. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cause clause for a budget that was spent before the answer began. */
export const BUDGET_SPENT_ON_REASONING = "the model's reasoning used the whole budget.";
/** Cause clause for an answer that started but was cut off mid-JSON. */
export const INCOMPLETE_JSON_ANSWER = "the JSON answer is incomplete.";

/**
 * Both wire formats report truncation the same way: the budget that was sent
 * is the actionable part, so the message names it.
 */
export function truncationError(label: string, maxTokens: number, cause: string): Error {
  return new Error(
    `${label} response was cut off by max_tokens (${maxTokens}); ${cause} Raise maxTokens for this model.`
  );
}

/**
 * Converts Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Strips trailing slashes so `${baseUrl}/chat/completions` is well-formed. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
