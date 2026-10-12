# Feature intent: AI provider layer for easy model swapping

Status: implemented 2026-10-12 (see CHANGELOG [Unreleased]); live-tested against Mistral. Written 2026-10-12. Background: `barrieretest/docs/ai-feature-assessment.md`, section 5 (Mistral Large 4 decision) and section 6 D (quality architecture). Decision record on TanStack AI and Vercel AI SDK at the end.

## Outcome

Swapping the model behind the semantic pass is a configuration change, not a code change: `{ provider: "mistral", model: "mistral-large-4" }` or `{ provider: "openai-compatible", baseUrl: "https://api.tokenfactory.nebius.com/v1", model: "..." }`. Every provider accepts the same request shape (system prompt, text, zero or more PNG images, a JSON schema for the response, a timeout) and returns the same response shape (parsed object, raw text, model id actually used, token usage). Capabilities a model lacks (vision, JSON schema) are declared, not discovered by a failed request. The semantic runner no longer parses JSON out of free text when the provider can enforce a schema.

## Why

- Production has been sending screenshots to a text-only model with no error surfaced. A capability declaration would have refused that configuration at startup.
- Mistral is not on Nebius, so the next model needs a new endpoint. Three of the four target endpoints (Mistral, OpenAI, Nebius) speak the OpenAI chat-completions shape; today they are three near-identical fetch implementations plus Anthropic.
- Structured output via `response_format: json_schema` is available on all target providers and removes the regex JSON extraction and most of the field-validation code in `src/semantic/parse.ts`.
- The set-of-mark work needs two images per request; the current `SemanticAnalysisInput` carries one.

## Invariants

1. `@barrieretest/core` keeps a single runtime dependency (`axe-core`). The provider layer is own code over `fetch`. See the decision record for why.
2. The public `AIProvider` interface stays the seam. Internals may change; `createProvider(name, config)` keeps working for existing callers of `enhanceWithAI` and `semanticAudit` for one minor version, with a deprecation note.
3. API keys never leave env or the explicit `apiKey` option; the layer never logs request bodies.
4. Every request has a timeout and an abort path. A provider that cannot honour the signal is not a supported provider.
5. Unsupported capability is a configuration error before the first network call, with a message naming the model and the capability.
6. The semantic runner's behaviour with a provider that lacks JSON-schema support is unchanged: it falls back to the current prompt-described schema plus `parseSemanticResponse`.

## Scope

### Model registry and capabilities

```ts
export type ProviderKind = "mistral" | "openai" | "anthropic" | "openai-compatible";

export interface ModelCapabilities {
  vision: boolean;
  jsonSchema: boolean;          // response_format: json_schema or equivalent
  maxImagesPerRequest?: number;
  contextTokens?: number;
}

export interface AIProviderConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  /** Required for "openai-compatible"; optional override for others (e.g. api.eu.mistral.ai). */
  baseUrl?: string;
  /** Overrides or supplies capabilities for models not in the built-in table. */
  capabilities?: Partial<ModelCapabilities>;
  maxTokens?: number;
  temperature?: number;
  /** Default per-request timeout in ms. */
  timeout?: number;
}
```

A small built-in table (`src/ai/models.ts`) lists known models with capabilities: Mistral Large 4, Medium 3.5, Small 4; OpenAI current vision models; Anthropic current models; `openai/gpt-oss-120b` as `vision: false`. Unknown model ids on `openai-compatible` default to `vision: false, jsonSchema: false` unless `capabilities` says otherwise, so the safe default is the restrictive one. `nebius` as a provider name is kept as an alias for `openai-compatible` with the Nebius base URL, so existing configs keep working.

### Unified request and response

```ts
export interface ModelRequest {
  system?: string;
  text: string;
  images?: { png: Uint8Array; label?: string }[];   // label is prepended as text, e.g. "Image 2: same capture with numbered marks"
  /** When set and the model supports it, enforce via provider-native structured output. */
  responseSchema?: JsonSchemaObject;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  /** Parsed JSON when responseSchema was given and the provider enforced it; undefined otherwise. */
  json?: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AIProvider {
  name: ProviderKind;
  model: string;
  capabilities: ModelCapabilities;
  complete(request: ModelRequest): Promise<ModelResponse>;
  // existing analyze() and analyzeSemantic() remain as thin wrappers over complete() for one minor version
}
```

### Transports

- `src/ai/transports/openai-chat.ts`: one implementation of the chat-completions shape, parameterised by `baseUrl`, header builder and quirks (Mistral and Nebius accept `image_url` data URLs; `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`). Used by `mistral`, `openai`, `openai-compatible`.
- `src/ai/transports/anthropic-messages.ts`: existing Anthropic code, adapted to `ModelRequest`; structured output via a single forced tool call whose input schema is the response schema, which is the provider's documented route.
- Both: `AbortController` with timeout, HTTP error mapping with status and a truncated body, `usage` extraction, retry once on 429 and 5xx with jittered backoff (bounded, not configurable in this iteration).

### Semantic runner changes

- `SemanticAnalysisInput` gains `images` (array) in place of `screenshot`; `screenshot` kept as an alias for one version.
- When `provider.capabilities.jsonSchema` is true, the runner passes the semantic response schema (derived from today's prose description in `buildResponseSection`) as `responseSchema`, and uses `response.json` directly; `parseSemanticResponse` runs only on the fallback path.
- When a selected check needs a screenshot and `capabilities.vision` is false, the runner throws a configuration error naming the check and the model before extracting context. Callers that want to run text-only checks pass a check subset.

### Surfaces

- CLI: `--semantic-provider` accepts `mistral` and `openai-compatible`; new `--semantic-base-url`; env inference adds `MISTRAL_API_KEY`. `init` wizard offers Mistral with Large 4 as the suggested model and Small 4 as the budget option.
- Config keys: `semantic.baseUrl`, `semantic.capabilities` (object).
- README: provider table with capabilities; the gpt-oss-120b text-only note; EU endpoint example.
- CHANGELOG `[Unreleased]`: Added mistral and openai-compatible providers, capabilities, structured output; Deprecated single `screenshot` field; Changed Nebius default now declares `vision: false`.

## Non-goals

- Streaming, tool calling, agent loops, embeddings.
- Per-criterion prompt decomposition and the grounding gate (separate intent; this layer only makes them possible by supporting several images and schemas).
- Cost accounting beyond returning `usage`.
- A plugin mechanism for third-party providers beyond `openai-compatible` and the exported transport classes.

## Acceptance criteria

1. `createProvider({ provider: "mistral", model: "mistral-large-4", apiKey })` sends to `https://api.mistral.ai/v1/chat/completions` with two `image_url` parts and `response_format.type === "json_schema"` when given two images and a schema (asserted against a stubbed `fetch`).
2. `provider: "openai-compatible"` with the Nebius base URL and `model: "openai/gpt-oss-120b"` reports `capabilities.vision === false`; `semanticAudit` with the default checks throws before any network call, and with `checks: ["lang-attribute"]` it runs.
3. `baseUrl: "https://api.eu.mistral.ai/v1"` is honoured for `mistral`.
4. A request that exceeds `timeout` rejects with an error naming the provider and the timeout, and the underlying `fetch` receives an aborted signal.
5. A 429 followed by a 200 yields the 200 result; two 500s yield the error.
6. With a `jsonSchema` provider, `runSemanticAudit` produces identical `Issue[]` from `response.json` as it does today from the same payload as text; the existing semantic tests pass on the fallback path unchanged.
7. `createProvider("nebius", { apiKey, model })` (old signature) still works and logs one deprecation warning.
8. `package.json` `dependencies` still lists only `axe-core`.

## Validation

- Unit tests with stubbed `fetch` for both transports: request shape, image encoding, schema passthrough, timeout, retry, error mapping.
- Existing `src/semantic/semantic.test.ts` and `src/ai/types.test.ts` pass unchanged; new tests for the capability gate.
- `npm run typecheck`, `npm run lint`, `npm test`.
- One manual run against Mistral with `MISTRAL_API_KEY` set by Andreas (the agent must not read or print the key): `npx barrieretest <url> --semantic --semantic-provider mistral --semantic-model mistral-large-4`, confirming the model id returned and that findings parse via the schema path. Record the model id and image token count in the report.

## Decision record: TanStack AI and Vercel AI SDK

Researched 2026-10-12.

**TanStack AI** (`@tanstack/ai` 0.68.0, RC since 2026-08-21) covers every feature needed on paper: a Mistral adapter, an `openai-compatible` adapter that names Nebius as a target, multi-part image messages, schema-enforced one-shot output, custom adapters via a small base class. Against adopting it now:

- Still 0.x with breaking commits landing in the week of writing (`chat({ reasoning })` marked `feat!`), seven-plus renames in the migration guide without version numbers, and no written semver policy.
- `chat()` has no timeout option (open issue since 2026-09-26), and the native Mistral adapter 0.6.18 does not forward the abort signal at all. Invariant 4 fails out of the box.
- Adapters wrap the vendor SDKs: core plus OpenAI, Anthropic and Mistral adapters measured at about 70 MB and 28 packages. Core today installs one dependency.
- Bun is not documented as a supported runtime.

**Vercel AI SDK** (`ai` 7.0.x) is the mature alternative: stable major, built-in `timeout` and `abortSignal`, first-party Mistral and openai-compatible providers, about 30 MB with three providers, zod as a required peer.

**Decision: own thin layer, no dependency.** The need is one request shape over two wire formats. That is roughly 300 lines of own code, which is less than the surface area either SDK would add to a library whose users install it next to Puppeteer. The `AIProvider` seam keeps the option open: if the provider count or feature list grows (streaming, tools, more vendors), wrap Vercel AI SDK behind the same interface as an optional peer. Revisit TanStack AI at 1.0 with a semver policy and timeout support.

## Open decisions for Andreas

1. Keep `anthropic` as a built-in transport, or drop it to `openai-compatible` users and reduce the layer to one wire format? Proposed: keep; it is already written and the structured-output route differs.
2. Should the capability table ship model ids that will age (Large 4 is in preview), or only families with a `capabilities` override expected in config? Proposed: ship ids with a comment that the table is advisory and `capabilities` wins.
3. Retry policy fixed (once, 429 and 5xx) or configurable? Proposed: fixed for now.
