import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createProvider, resolveCapabilities } from "./index.js";

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02]);
const NEBIUS_URL = "https://api.tokenfactory.nebius.com/v1";
const SCHEMA = {
  type: "object",
  properties: { findings: { type: "array", items: { type: "string" } } },
  required: ["findings"],
  additionalProperties: false,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
});

/**
 * Stub `globalThis.fetch` with one factory per expected call; the last
 * factory is reused if more calls arrive, so a test can assert the exact
 * call count instead of crashing on an unexpected extra request.
 */
function stubFetch(responses: (() => Response)[]): void {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(responses[Math.min(calls.length - 1, responses.length - 1)]());
  }) as unknown as typeof fetch;
}

function chatResponse(content: string, extra: Record<string, unknown> = {}): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        model: "server-reported-model",
        choices: [{ message: { content } }],
        ...extra,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
}

/** The array-of-chunks message shape reasoning models return. */
function chatChunksResponse(
  content: Record<string, unknown>[],
  finishReason: string
): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        model: "server-reported-model",
        choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
}

function errorResponse(status: number, body = "upstream failure"): () => Response {
  return () => new Response(body, { status });
}

interface StallingBody {
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the consumer has read the first chunk and asked for more. */
  reading: Promise<void>;
  cancelled: () => boolean;
}

/**
 * A response body that delivers one chunk and then never closes — the "server
 * sent headers and stalled" case.
 */
function stallingBody(firstChunk = "{"): StallingBody {
  let cancelled = false;
  let onRead = (): void => {};
  const reading = new Promise<void>((resolve) => {
    onRead = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
    pull() {
      onRead();
      return new Promise<never>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });

  return { stream, reading, cancelled: () => cancelled };
}

function abortReason(): Error {
  const reason = new Error("cancelled by caller");
  reason.name = "AbortError";
  return reason;
}

function requestBody(call: FetchCall): Record<string, any> {
  return JSON.parse(call.init.body as string);
}

function requestHeaders(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("chat-completions transport", () => {
  it("posts text, images and a json schema to the Mistral endpoint", async () => {
    stubFetch([
      chatResponse(JSON.stringify({ findings: ["a"] }), {
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });
    const response = await provider.complete!({
      text: "describe the page",
      images: [
        { png: PNG_A, label: "Image 1: capture" },
        { png: PNG_B, label: "Image 2: same capture with numbered marks" },
      ],
      responseSchema: SCHEMA,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(requestHeaders(calls[0]).Authorization).toBe("Bearer test-key");

    const body = requestBody(calls[0]);
    expect(body.model).toBe("mistral-large-4");
    const parts = body.messages[0].content;
    expect(parts[0]).toEqual({ type: "text", text: "describe the page" });
    expect(parts.filter((p: { type: string }) => p.type === "image_url")).toHaveLength(2);
    expect(parts[1]).toEqual({ type: "text", text: "Image 1: capture" });
    expect(parts[2].image_url.url).toStartWith("data:image/png;base64,");
    // detail is OpenAI-only
    expect(parts[2].image_url.detail).toBeUndefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema).toEqual({
      name: "response",
      schema: SCHEMA,
      strict: true,
    });

    expect(response.json).toEqual({ findings: ["a"] });
    expect(response.text).toBe(JSON.stringify({ findings: ["a"] }));
    expect(response.model).toBe("server-reported-model");
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("honours a baseUrl override", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("mistral", {
      apiKey: "test-key",
      model: "mistral-small-2603",
      baseUrl: "https://api.eu.mistral.ai/v1",
    });
    await provider.complete!({ text: "hi" });

    expect(calls[0].url).toBe("https://api.eu.mistral.ai/v1/chat/completions");
  });

  it("sends a system message and the OpenAI detail hint", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("openai", { apiKey: "test-key" });
    await provider.complete!({ text: "hi", system: "be terse", images: [{ png: PNG_A }] });

    const body = requestBody(calls[0]);
    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(body.messages[1].content[1].image_url.detail).toBe("high");
  });

  it("leaves json undefined when the content is not valid JSON", async () => {
    stubFetch([chatResponse("not json")]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    const response = await provider.complete!({ text: "hi", responseSchema: SCHEMA });

    expect(response.text).toBe("not json");
    expect(response.json).toBeUndefined();
  });

  it("omits response_format when the model cannot enforce a schema", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("openai-compatible", {
      apiKey: "test-key",
      baseUrl: NEBIUS_URL,
      model: "openai/gpt-oss-120b",
    });
    await provider.complete!({ text: "hi", responseSchema: SCHEMA });

    expect(requestBody(calls[0]).response_format).toBeUndefined();
  });

  it("keeps only the text chunks when the content is an array", async () => {
    stubFetch([
      chatChunksResponse(
        [
          { type: "thinking", thinking: [{ type: "text", text: "weighing it up" }], closed: true },
          { type: "text", text: JSON.stringify({ findings: ["a"] }) },
        ],
        "stop"
      ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });
    const response = await provider.complete!({ text: "hi", responseSchema: SCHEMA });

    expect(response.text).toBe(JSON.stringify({ findings: ["a"] }));
    expect(response.json).toEqual({ findings: ["a"] });
    expect(response.finishReason).toBe("stop");
  });

  it("concatenates the text chunks in order across interleaved chunk types", async () => {
    stubFetch([
      chatChunksResponse(
        [
          { type: "thinking", thinking: [{ type: "text", text: "weighing it up" }] },
          { type: "text", text: "A" },
          { type: "reference", reference_ids: [3] },
          { type: "text", text: "B" },
          { type: "something_new", payload: "from a later API version" },
          { type: "text", text: "C" },
        ],
        "stop"
      ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });
    const response = await provider.complete!({ text: "hi" });

    expect(response.text).toBe("ABC");
  });

  it("reports truncation when reasoning consumed the whole token budget", async () => {
    stubFetch([
      chatChunksResponse(
        [{ type: "thinking", thinking: [{ type: "text", text: "still thinking" }] }],
        "length"
      ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });

    await expect(
      provider.complete!({ text: "hi", responseSchema: SCHEMA, maxTokens: 64 })
    ).rejects.toThrow(
      "Mistral response was cut off by max_tokens (64); the model's reasoning used the whole budget. Raise maxTokens for this model."
    );
  });

  it("omits reasoning_effort for a model that does not reason by default", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-small-2603" });
    await provider.complete!({ text: "hi" });

    expect(requestBody(calls[0]).reasoning_effort).toBeUndefined();
  });

  it("turns reasoning off for a declared reasoning model with no configured effort", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });
    await provider.complete!({ text: "hi" });

    expect(requestBody(calls[0]).reasoning_effort).toBe("none");
  });

  it("omits reasoning_effort when capabilities declare the model as non-reasoning", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("mistral", {
      apiKey: "test-key",
      model: "mistral-large-4",
      capabilities: { reasoning: false },
    });
    await provider.complete!({ text: "hi" });

    expect(requestBody(calls[0])).not.toHaveProperty("reasoning_effort");
  });

  it("sends a configured reasoningEffort verbatim, reasoning model or not", async () => {
    stubFetch([chatResponse("ok")]);

    const reasoner = createProvider("mistral", {
      apiKey: "test-key",
      model: "mistral-large-4",
      reasoningEffort: "high",
    });
    await reasoner.complete!({ text: "hi" });
    expect(requestBody(calls[0]).reasoning_effort).toBe("high");

    const plain = createProvider("openai", {
      apiKey: "test-key",
      model: "gpt-4o",
      reasoningEffort: "medium",
    });
    await plain.complete!({ text: "hi" });
    expect(requestBody(calls[1]).reasoning_effort).toBe("medium");
  });

  it("sends prompt_cache_key on mistral and openai and parses cached input tokens", async () => {
    stubFetch([
      chatResponse("ok", {
        usage: {
          prompt_tokens: 1600,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 1536 },
        },
      }),
    ]);

    const mistral = createProvider("mistral", { apiKey: "test-key", model: "mistral-small-2603" });
    const response = await mistral.complete!({
      text: "hi",
      cacheKey: "barrieretest-semantic-large-0a1b2c3d",
    });

    expect(requestBody(calls[0]).prompt_cache_key).toBe("barrieretest-semantic-large-0a1b2c3d");
    expect(response.usage).toEqual({
      inputTokens: 1600,
      outputTokens: 20,
      cachedInputTokens: 1536,
    });

    const openai = createProvider("openai", { apiKey: "test-key" });
    await openai.complete!({ text: "hi", cacheKey: "barrieretest-semantic-small-0a1b2c3d" });

    expect(requestBody(calls[1]).prompt_cache_key).toBe("barrieretest-semantic-small-0a1b2c3d");
  });

  it("omits prompt_cache_key for an arbitrary compatible server and when unset", async () => {
    stubFetch([chatResponse("ok")]);

    const compatible = createProvider("openai-compatible", {
      apiKey: "test-key",
      baseUrl: NEBIUS_URL,
      model: "openai/gpt-oss-120b",
    });
    await compatible.complete!({ text: "hi", cacheKey: "barrieretest-semantic-large-0a1b2c3d" });
    expect(requestBody(calls[0])).not.toHaveProperty("prompt_cache_key");

    const nebius = createProvider("nebius", { apiKey: "test-key" });
    await nebius.complete!({ text: "hi", cacheKey: "barrieretest-semantic-large-0a1b2c3d" });
    expect(requestBody(calls[1])).not.toHaveProperty("prompt_cache_key");

    const mistral = createProvider("mistral", { apiKey: "test-key", model: "mistral-small-2603" });
    await mistral.complete!({ text: "hi" });
    expect(requestBody(calls[2])).not.toHaveProperty("prompt_cache_key");
  });

  it("reports truncation when the cut-off answer does not parse as JSON", async () => {
    stubFetch([
      chatChunksResponse(
        [
          { type: "thinking", thinking: [{ type: "text", text: "weighing it up" }] },
          { type: "text", text: '{"findings":[' },
        ],
        "length"
      ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });

    await expect(
      provider.complete!({ text: "hi", responseSchema: SCHEMA, maxTokens: 2000 })
    ).rejects.toThrow(
      "Mistral response was cut off by max_tokens (2000); the JSON answer is incomplete. Raise maxTokens for this model."
    );
  });

  it("returns a cut-off answer that still parses, with finishReason", async () => {
    stubFetch([chatChunksResponse([{ type: "text", text: '{"findings":[]}' }], "length")]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });
    const response = await provider.complete!({ text: "hi", responseSchema: SCHEMA });

    expect(response.json).toEqual({ findings: [] });
    expect(response.finishReason).toBe("length");
  });

  it("returns cut-off text unchanged when no schema was requested", async () => {
    stubFetch([chatChunksResponse([{ type: "text", text: "a half-written senten" }], "length")]);

    const provider = createProvider("mistral", { apiKey: "test-key", model: "mistral-large-4" });
    const response = await provider.complete!({ text: "hi" });

    expect(response.text).toBe("a half-written senten");
    expect(response.json).toBeUndefined();
    expect(response.finishReason).toBe("length");
  });
});

describe("capability gate", () => {
  it("refuses images on a text-only model before any network call", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("openai-compatible", {
      apiKey: "test-key",
      baseUrl: NEBIUS_URL,
      model: "openai/gpt-oss-120b",
    });

    expect(provider.capabilities?.vision).toBe(false);
    await expect(provider.complete!({ text: "hi", images: [{ png: PNG_A }] })).rejects.toThrow(
      "Model 'openai/gpt-oss-120b' on provider 'openai-compatible' does not support images; 1 image(s) were supplied"
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses more images than the model accepts", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("mistral", {
      apiKey: "test-key",
      model: "mistral-large-4",
      capabilities: { maxImagesPerRequest: 1 },
    });

    await expect(
      provider.complete!({ text: "hi", images: [{ png: PNG_A }, { png: PNG_B }] })
    ).rejects.toThrow("supports at most 1 image(s) per request; 2 were supplied");
    expect(calls).toHaveLength(0);
  });

  it("resolves capabilities from the table, with config overriding", () => {
    expect(resolveCapabilities("mistral", "mistral-large-4")).toEqual({
      vision: true,
      jsonSchema: true,
      reasoning: true,
    });
    expect(resolveCapabilities("mistral", "mistral-small-2603")).toEqual({
      vision: true,
      jsonSchema: true,
    });
    expect(resolveCapabilities("mistral", "mistral-large-4", { reasoning: false })).toEqual({
      vision: true,
      jsonSchema: true,
      reasoning: false,
    });
    expect(resolveCapabilities("openai-compatible", "some/unlisted-model")).toEqual({
      vision: false,
      jsonSchema: false,
    });
    expect(
      resolveCapabilities("openai-compatible", "openai/gpt-oss-120b", { jsonSchema: true })
    ).toEqual({ vision: false, jsonSchema: true });
  });
});

describe("timeout and abort", () => {
  it("rejects naming the provider and the timeout, and aborts the fetch signal", async () => {
    let observedAbort = false;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const provider = createProvider("mistral", { apiKey: "test-key", timeout: 10 });

    await expect(provider.complete!({ text: "hi" })).rejects.toThrow(
      "Mistral request timed out after 10ms"
    );
    expect(observedAbort).toBe(true);
  });

  it("propagates an external abort without rewriting it as a timeout", async () => {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const provider = createProvider("mistral", { apiKey: "test-key" });
    const pending = provider.complete!({ text: "hi", signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow("The operation was aborted.");
  });

  it("times out while the response body is still streaming", async () => {
    const body = stallingBody();
    stubFetch([() => new Response(body.stream, { status: 200 })]);

    const provider = createProvider("mistral", { apiKey: "test-key", timeout: 10 });

    await expect(provider.complete!({ text: "hi" })).rejects.toThrow(
      "Mistral request timed out after 10ms"
    );
    expect(body.cancelled()).toBe(true);
  });

  it("propagates an external abort during the body read", async () => {
    const body = stallingBody();
    stubFetch([() => new Response(body.stream, { status: 200 })]);

    const controller = new AbortController();
    const provider = createProvider("mistral", { apiKey: "test-key" });
    const pending = provider.complete!({ text: "hi", signal: controller.signal });

    await body.reading;
    controller.abort(abortReason());

    await expect(pending).rejects.toThrow("cancelled by caller");
    expect(body.cancelled()).toBe(true);
  });

  it("rejects an already-aborted caller signal without calling fetch", async () => {
    stubFetch([chatResponse("ok")]);

    const controller = new AbortController();
    controller.abort(abortReason());

    const provider = createProvider("mistral", { apiKey: "test-key" });

    await expect(provider.complete!({ text: "hi", signal: controller.signal })).rejects.toThrow(
      "cancelled by caller"
    );
    expect(calls).toHaveLength(0);
  });

  it("times out on an error response whose body stalls", async () => {
    const body = stallingBody("upstream fail");
    stubFetch([() => new Response(body.stream, { status: 500 })]);

    const provider = createProvider("mistral", { apiKey: "test-key", timeout: 10 });

    await expect(provider.complete!({ text: "hi" })).rejects.toThrow(
      "Mistral request timed out after 10ms"
    );
    expect(calls).toHaveLength(1);
    expect(body.cancelled()).toBe(true);
  });
});

describe("body decoding", () => {
  it("decodes a multibyte character split across two chunks", async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: "grüß gott" } }] });
    const bytes = new TextEncoder().encode(payload);
    // Split inside the two-byte "ü" so neither chunk decodes on its own.
    const splitAt = bytes.indexOf(0xc3) + 1;

    stubFetch([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, splitAt));
              controller.enqueue(bytes.slice(splitAt));
              controller.close();
            },
          }),
          { status: 200 }
        ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    const response = await provider.complete!({ text: "hi" });

    expect(response.text).toBe("grüß gott");
  });

  it("releases the body lock after a completed read", async () => {
    let served: Response | undefined;
    stubFetch([
      () => {
        served = new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
        return served;
      },
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    await provider.complete!({ text: "hi" });

    expect(served?.body?.locked).toBe(false);
  });

  it("releases the body lock after a cancelled read", async () => {
    const body = stallingBody();
    let served: Response | undefined;
    stubFetch([
      () => {
        served = new Response(body.stream, { status: 200 });
        return served;
      },
    ]);

    const controller = new AbortController();
    const provider = createProvider("mistral", { apiKey: "test-key" });
    const pending = provider.complete!({ text: "hi", signal: controller.signal });

    await body.reading;
    controller.abort(abortReason());

    await expect(pending).rejects.toThrow("cancelled by caller");
    expect(served?.body?.locked).toBe(false);
  });
});

describe("retry policy", () => {
  it("retries once after a 429", async () => {
    stubFetch([errorResponse(429), chatResponse("recovered")]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    const response = await provider.complete!({ text: "hi" });

    expect(calls).toHaveLength(2);
    expect(response.text).toBe("recovered");
  });

  it("gives up after a second 5xx", async () => {
    stubFetch([errorResponse(500, "boom")]);

    const provider = createProvider("mistral", { apiKey: "test-key" });

    await expect(provider.complete!({ text: "hi" })).rejects.toThrow(
      "Mistral API error: 500 - boom"
    );
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 400 and truncates the error body", async () => {
    const longBody = "x".repeat(900);
    stubFetch([errorResponse(400, longBody)]);

    const provider = createProvider("mistral", { apiKey: "test-key" });

    const error = await provider.complete!({ text: "hi" }).catch((e: Error) => e);
    expect(calls).toHaveLength(1);
    expect((error as Error).message).toBe(`Mistral API error: 400 - ${"x".repeat(500)}`);
  });

  it("still reports the status when the error body cannot be read", async () => {
    stubFetch([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 400 }
        ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key" });

    await expect(provider.complete!({ text: "hi" })).rejects.toThrow(
      "Mistral API error: 400 - <unreadable response body>"
    );
  });

  it("consumes the body of the retried response before the second attempt", async () => {
    let throttled: Response | undefined;
    let bodyUsedAtSecondCall: boolean | undefined;

    stubFetch([
      () => {
        throttled = new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("slow down"));
              controller.close();
            },
          }),
          { status: 429 }
        );
        return throttled;
      },
      () => {
        bodyUsedAtSecondCall = throttled?.bodyUsed;
        return chatResponse("recovered")();
      },
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    const response = await provider.complete!({ text: "hi" });

    expect(calls).toHaveLength(2);
    // The discarded response must not be left holding an unread stream.
    expect(bodyUsedAtSecondCall).toBe(true);
    expect(response.text).toBe("recovered");
  });

  it("abandons the retry when the caller aborts during the backoff", async () => {
    stubFetch([errorResponse(429), chatResponse("recovered")]);

    const controller = new AbortController();
    const provider = createProvider("mistral", { apiKey: "test-key" });
    const pending = provider.complete!({ text: "hi", signal: controller.signal });
    setTimeout(() => controller.abort(abortReason()), 5);

    await expect(pending).rejects.toThrow("cancelled by caller");
    expect(calls).toHaveLength(1);
  });
});

describe("anthropic messages transport", () => {
  it("forces a tool call for structured output and returns the tool input", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", name: "response", input: { findings: ["b"] } }],
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ]);

    const provider = createProvider("anthropic", { apiKey: "test-key" });
    const response = await provider.complete!({
      text: "hi",
      system: "be terse",
      responseSchema: SCHEMA,
    });

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requestHeaders(calls[0])["x-api-key"]).toBe("test-key");

    const body = requestBody(calls[0]);
    expect(body.tools).toEqual([{ name: "response", input_schema: SCHEMA }]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "response" });
    expect(body.system).toBe("be terse");

    expect(response.json).toEqual({ findings: ["b"] });
    expect(response.text).toBe(JSON.stringify({ findings: ["b"] }));
    expect(response.finishReason).toBe("tool_use");
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("ignores the cache key and counts cache reads into the input total", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "plain answer" }],
            usage: { input_tokens: 200, output_tokens: 12, cache_read_input_tokens: 1400 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ]);

    const provider = createProvider("anthropic", { apiKey: "test-key" });
    const response = await provider.complete!({
      text: "hi",
      cacheKey: "barrieretest-semantic-large-0a1b2c3d",
    });

    // Anthropic caches via `cache_control`, which this transport does not set.
    expect(requestBody(calls[0])).not.toHaveProperty("prompt_cache_key");
    // Anthropic reports cache reads beside `input_tokens`; `inputTokens` is
    // documented as the total that `cachedInputTokens` is part of.
    expect(response.usage).toEqual({
      inputTokens: 1600,
      outputTokens: 12,
      cachedInputTokens: 1400,
    });
  });

  it("adds cache writes to the input total as well", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "plain answer" }],
            usage: {
              input_tokens: 200,
              output_tokens: 12,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 500,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ]);

    const provider = createProvider("anthropic", { apiKey: "test-key" });
    const response = await provider.complete!({ text: "hi" });

    expect(response.usage).toEqual({
      inputTokens: 1600,
      outputTokens: 12,
      cachedInputTokens: 900,
    });
  });

  it("reports zeros and no cached count when usage carries no token fields", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "plain answer" }],
            usage: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ]);

    const provider = createProvider("anthropic", { apiKey: "test-key" });
    const response = await provider.complete!({ text: "hi" });

    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("reports truncation when the forced tool call was cut off", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            stop_reason: "max_tokens",
            content: [{ type: "text", text: "I will now call the tool" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ]);

    const provider = createProvider("anthropic", { apiKey: "test-key" });

    await expect(
      provider.complete!({ text: "hi", responseSchema: SCHEMA, maxTokens: 2000 })
    ).rejects.toThrow(
      "Anthropic response was cut off by max_tokens (2000); the JSON answer is incomplete. Raise maxTokens for this model."
    );
  });

  it("returns the first text block when no schema is requested", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "plain answer" }] }), {
          status: 200,
        }),
    ]);

    const provider = createProvider("anthropic", { apiKey: "test-key", reasoningEffort: "high" });
    const response = await provider.complete!({ text: "hi" });

    expect(requestBody(calls[0]).tools).toBeUndefined();
    // The messages API has no such field; the option is ignored here.
    expect(requestBody(calls[0]).reasoning_effort).toBeUndefined();
    expect(response.text).toBe("plain answer");
    expect(response.json).toBeUndefined();
    expect(response.model).toBe("claude-sonnet-4-20250514");
  });
});

describe("configuration errors", () => {
  it("names the env var for an empty API key", () => {
    expect(() => createProvider("mistral", { apiKey: "" })).toThrow(
      "Mistral provider requires an API key (set MISTRAL_API_KEY or pass apiKey)"
    );
    expect(() => createProvider("openai", { apiKey: "   " })).toThrow(
      "OpenAI provider requires an API key (set OPENAI_API_KEY or pass apiKey)"
    );
    expect(() => createProvider("anthropic", { apiKey: "" })).toThrow(
      "Anthropic provider requires an API key (set ANTHROPIC_API_KEY or pass apiKey)"
    );
    expect(() => createProvider("nebius", { apiKey: "" })).toThrow(
      "Nebius provider requires an API key (set NEBIUS_API_KEY or pass apiKey)"
    );
    expect(() => createProvider("openai-compatible", { apiKey: "" })).toThrow(
      "OpenAI-compatible provider requires an API key (set OPENAI_COMPATIBLE_API_KEY or pass apiKey)"
    );
  });

  it("requires baseUrl and model for openai-compatible", () => {
    expect(() => createProvider("openai-compatible", { apiKey: "k", model: "m" })).toThrow(
      "OpenAI-compatible provider requires a baseUrl"
    );
    expect(() => createProvider("openai-compatible", { apiKey: "k", baseUrl: NEBIUS_URL })).toThrow(
      "OpenAI-compatible provider requires a model"
    );
  });

  it("rejects an unknown provider name", () => {
    expect(() =>
      createProvider("gemini" as Parameters<typeof createProvider>[0], { apiKey: "k" })
    ).toThrow("Unknown AI provider: gemini");
  });
});

describe("legacy wrappers", () => {
  it("keeps nebius working as an alias with its own name and default model", async () => {
    stubFetch([chatResponse("ok")]);

    const provider = createProvider("nebius", { apiKey: "test-key" });
    await provider.complete!({ text: "hi" });

    expect(provider.name).toBe("nebius");
    expect(provider.model).toBe("openai/gpt-oss-120b");
    expect(calls[0].url).toBe(`${NEBIUS_URL}/chat/completions`);
  });

  it("analyzeSemantic still returns content and model", async () => {
    stubFetch([chatResponse('{"findings":[]}')]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    const result = await provider.analyzeSemantic!({
      prompt: "audit this",
      system: "be terse",
      screenshot: PNG_A,
      timeout: 5000,
    });

    expect(result).toEqual({ content: '{"findings":[]}', model: "server-reported-model" });
    const body = requestBody(calls[0]);
    expect(body.max_tokens).toBe(4000);
    expect(body.messages[1].content[1].type).toBe("image_url");
  });

  it("analyze still parses the per-issue JSON response", async () => {
    stubFetch([
      chatResponse(
        JSON.stringify({
          contextualAnalysis: "low contrast",
          suggestedFix: "<button>Submit</button>",
          confidence: 0.9,
        })
      ),
    ]);

    const provider = createProvider("mistral", { apiKey: "test-key" });
    const analysis = await provider.analyze({
      issue: {
        id: "color-contrast",
        impact: "serious",
        description: "insufficient contrast",
        help: "raise the contrast ratio",
        selector: "button",
        nodes: [{ html: "<button>Submit</button>" }],
      },
    });

    expect(analysis).toEqual({
      contextualAnalysis: "low contrast",
      suggestedFix: "<button>Submit</button>",
      confidence: 0.9,
    });
    expect(requestBody(calls[0]).max_tokens).toBe(1024);
  });
});

describe("dependency budget", () => {
  it("keeps axe-core as the only runtime dependency", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { dependencies: Record<string, string> };

    expect(Object.keys(pkg.dependencies)).toEqual(["axe-core"]);
  });
});
