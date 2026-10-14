# Proposal: add-connector-aimlapi

## Why

[AI/ML API](https://aimlapi.com) is a single OpenAI-compatible gateway in
front of hundreds of models from many vendors: 365 chat models (GPT,
Claude, Gemini, DeepSeek, Qwen, Kimi, Llama, Mistral, …), 125 image
models (FLUX, GPT-Image, Qwen-Image, Seedream, Imagen, …), plus
embeddings, audio and video families — one key, one base url, one bill.
Submitted by the vendor.

It fills the same catalog gap a general-purpose LLM connector fills — an
agent on Monid delegating a sub-task to a different model, a cheaper one
for bulk work, a reasoning one for a hard step — and does it across
vendors behind one credential instead of one vendor's own API. Every
endpoint here is a synchronous JSON request, so nothing needs a new
engine capability.

## What Changes

- **connectors/aimlapi** — provider (Bearer auth on
  `https://api.aimlapi.com/v1`, US-dollar pool, provider-level
  `usage.consolidate` and `output.fromError`) + 4 endpoints:
  `chat/completions`, `images/generations`, `models`, `key`.
- **Vendor claim on both billable endpoints.** Chat and image responses
  report the gateway's own charge as
  `meta.usage: {credits_used, usd_spent}`. The provider consolidate
  plucks that node and the claim wins (D27). The CREDIT is the gateway's
  NATIVE unit at a fixed rate — 8 credits / $0.000004 on a chat call and
  65,000 / $0.0325 on an image call are both exactly 2,000,000 credits
  per dollar, i.e. $0.0000005 each (verified live 2026-10-15) — so both
  endpoints meter `credits_used` and the derived fold reproduces the
  dollar claim exactly, leaving `usage.mismatch.derived` silent. One
  byte-identical `usage.evidence` serves both docs and interns to one
  fnTable entry. `pluck` is used rather than `omit` on purpose: the chat
  envelope also carries a top-level `usage` of token counts, which is the
  caller's and must survive.
- **Holds are CONNECTOR-OWNED CEILINGS, said so in the doc.** AI/ML API
  publishes no machine-readable rate card: there is no price field on
  `GET /v1/models`, none in `docs-json`, and no pricing endpoint
  (`/models/metrics` is latency only) — all checked 2026-10-15. So
  nothing here pins a per-model token table that would be stale on
  arrival. `chat/completions` requires `max_tokens` at the binding (the
  primary limiting knob — D25) and holds input at $200/1M and output at
  $800/1M, over prompt UTF-8 bytes + 1,000 tokens of gateway overhead +
  8,000 tokens per image part, times `n` on the output half.
  `images/generations` holds $1.00 per requested image. Both are above
  anything the gateway charges; the settle trues down to the reported
  claim, so a generous hold costs headroom and never money. This is the
  one number in the connector that is OUR assertion rather than the
  vendor's, and it is guarded the way the repo guards vendors without a
  machine-readable surface: test:live plus the per-run D27 mismatch
  signal.
- **No model name is pinned anywhere.** `aimlapi#models` reports the live
  roster instead. That endpoint is also where the gateway's one real
  modelling trap is handled: the list mixes every endpoint family and the
  ONLY discriminator is a `type` field, where `openai/chat-completions`
  and `anthropic/messages` are BOTH chat (one call shape serves both) and
  a model id may appear once per family. 932 rows on 2026-10-15 carry 395
  chat-family rows that MERGE BY ID to 365 distinct chat models, and 125
  image rows. `type` is not a prefix test: `openai/embeddings` and
  `openai/responses/submit` share the `openai/` prefix and are not chat.
  The gateway's own `?type=` filter is deliberately not exposed — it
  takes one type, and one run is one request, so a caller-chosen type
  would make the two-type chat family unrepresentable.
- **Attribution, gated on the DESTINATION.** Requests that reach the
  gateway carry `X-AIMLAPI-Source: agent/monid`, `HTTP-Referer` (this
  repo) and `X-Title: Monid`, plus `X-AIMLAPI-Partner-ID` once AI/ML API
  mints an id for monid. The headers ride on `auth.inject`, not
  `request.headers`: static headers are attached by the compiler and
  would egress to WHATEVER host the resolved url names, whereas
  `auth.inject` is the last hook before the wire and the only one handed
  the resolved url, so a `request.baseUrl` override moves attribution
  with it. The host test is EQUALITY on the parsed hostname — never a
  substring or suffix test, which would hand the partner id to
  `api.aimlapi.com.example.net`. `URL` is not a whitelisted closed-term
  global, so the authority is cut out with string ops and anything
  unparseable falls through unattributed. The partner id ships EMPTY and
  the header is omitted entirely while it is; filling it in is one
  literal, and a test reads that literal back out of the compiled fn and
  holds it to `^$|^part_[A-Za-z0-9]{1,64}$`.
- **Faithful mirrors, scoped.** `chat/completions` mirrors the
  OpenAI-compatible body with optionality only; `n` is defaulted to 1 at
  the binding (verified vendor default). `images/generations` is a
  `z.looseObject` over `{model, prompt}` — the gateway's published schema
  for that path is an `anyOf` of ONE ARM PER MODEL (125 of them) whose
  only universal fields are those two, with the count knob spelled `n` on
  OpenAI-shaped models, `num_images` on fal-shaped ones and absent on
  others, so a merged superset would type fields most models reject and a
  binding default would materialize a field onto the wire for models that
  have none.
- **Category** — new leaf `text-generation` in `connectors/categories.ts`
  (the GENERATIVE group, beside `image-generation`), since no existing
  leaf names an LLM completion.
- Real recorded fixtures as provider-level shared chains (7) with
  `{{request.url}}` bindings, plus replay, schema-gate, attribution and
  gated-live tests.

## Capabilities

- `aimlapi-connector`.

## Non-goals

- **Streaming** (`stream: true`) — the engine settles one envelope; an
  SSE body would arrive as an undecodable string.
- **`max_completion_tokens`** — the newer OpenAI spelling of the same
  cap. Exposing both would give the pre-run hold two knobs to disagree
  about; the connector takes `max_tokens`, which every chat model on the
  gateway accepts.
- **`/v1/embeddings`**, **`/v1/responses`**, the audio and video families
  — real surfaces, but each is its own rate story (and the video and
  speech-to-text families are `internal/*/submit` async jobs needing the
  lifecycle hooks), so they are follow-ups.
- **`/v1/images/editing`** and the image-to-image models — image inputs
  (multipart or large base64).
- **Anthropic-native `/v1/messages`, batches** — every chat model that
  publishes an `anthropic/messages` row also publishes an
  `openai/chat-completions` one, so the OpenAI-compatible path reaches
  all of them; batches are an async protocol of their own.
- **A pinned per-model rate card** — see above: there is nothing
  machine-readable to pin or to drift against.

## Impact

New connector tree, one new category leaf, four new ids in
`connectors/ids.lock.json`; no schema/engine/compiler changes — version
stays.

Note for review: `text-generation` is the same new leaf
`add-connector-venice` introduces, in the same place and with the same
text — whichever lands second drops its copy.
