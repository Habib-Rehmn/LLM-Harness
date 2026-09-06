# Model providers

Forge exposes model backends through `@forge/llm-core`. The rest of the runtime consumes one
canonical request and event protocol rather than OpenAI-, Ollama-, or vendor-shaped messages.

## Canonical contract

Every provider implements model discovery, capability lookup, token counting, and an async event
stream. Events cover text, reasoning summaries, tool-call lifecycle, usage, and completion.
`collectModelResponse` validates event ordering and reconstructs tool arguments from fragments;
malformed or incomplete calls fail with a typed `ProviderError`.

`ProviderRegistry` supports scoped registration and deterministic discovery. Provider plugins
publish the multi-provider `forge.llm-provider` service, so unloading their Forge scope removes
the registration.

## Included providers

- `@forge/provider-openai-compatible` maps chat-completions SSE, including Unicode chunking,
  reasoning fields, usage, fragmented tool arguments, cancellation, timeout, and HTTP errors.
- `@forge/provider-ollama` maps `/api/tags` discovery and `/api/chat` NDJSON generation, including
  native tool calls and Ollama token counts.
- `@forge/provider-custom-http` applies a JSON request template and configured dot-path response
  mappings for JSON, NDJSON, or SSE endpoints. Authentication configuration stores a `secretRef`;
  the credential is supplied at request time by a resolver.
- `FakeLlmProvider` supplies queued deterministic responses for agent and interface tests.

Each adapter also exports a `create...Plugin` factory for profile composition.

## Capability degradation

Model profiles declare context/output limits, streaming, native and parallel tools, structured
output, vision, caching, token counting, tool-result roles, and system-message support. Forge
selects one explicit tool level:

1. `native` for provider tool calls.
2. `constrained_json` when JSON Schema is available.
3. `prompted_protocol` only when the caller opts into the weaker fallback.
4. `none` when tools cannot be used safely.

`prepareToolRequest` performs the fallback transformation and returns a warning-bearing selection;
adapters reject unsupported native features rather than silently changing wire behavior.

## CLI conformance

```sh
forge models list --ollama-url http://127.0.0.1:11434
forge models test ollama/qwen2.5-coder:7b
```

`models list` prints discovered model profiles and the selected tool protocol. `models test` sends
a bounded, read-only probe and reports normalized text, calls, usage, and completion. Set
`OLLAMA_TEST_MODEL` while running the test suite to enable the opt-in live Ollama contract test;
fake-server conformance runs on every test invocation.
