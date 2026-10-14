import { defineEndpoint, Unit, UsageModelKind } from "@shared/core";
import { zChatCompletionsBody } from "./schema/inputs.ts";

/**
 * AI/ML API `POST /chat/completions` — one blocking, non-streaming
 * completion against any of the gateway's ~365 chat models.
 *
 * Billing: the gateway reports its own charge on every response as
 * `meta.usage: {credits_used, usd_spent}`. That claim is consolidated at
 * provider level and WINS (design D27). The CREDIT is the gateway's own
 * unit, fixed at $0.0000005 (2,000,000 credits per dollar — verified on
 * both the chat and image endpoints, 2026-10-15), so this doc meters
 * `credits_used` directly: the derived fold reproduces the dollar claim
 * exactly and the per-run mismatch check stays silent. Nothing here pins a
 * per-model token rate — there are 365 models and AI/ML API publishes no
 * machine-readable rate card, so a pinned table would be stale on arrival.
 *
 * The estimate is therefore a CEILING PIN, not a published rate (see
 * `estimate` below): `max_tokens` is REQUIRED at the binding (the primary
 * limiting knob — D25) and the hold prices the request well above the
 * dearest model on the gateway. A hold that is too generous is the safe
 * direction; the settle trues down to the reported charge.
 */
export default defineEndpoint({
    meta: {
        displayName: "AI/ML API Chat Completions",
        summary: "Chat with ~365 models from many vendors through one " +
            "OpenAI-compatible call.",
        description: "OpenAI-compatible chat completions on AI/ML API. " +
            "Pick any chat model the gateway serves by its prefixed id — " +
            "`openai/gpt-4o-mini`, `anthropic/claude-opus-5.5`, " +
            "`deepseek/deepseek-v4-pro-0813`, `alibaba/qwen3-max`, … — and " +
            "the same request shape works for all of them, including the " +
            "models whose native API is Anthropic's `/messages`. Supports " +
            "system prompts, multi-turn history, image input on vision " +
            "models, function calling, JSON-schema structured output and " +
            "reasoning effort. Billed at the gateway's own reported charge " +
            "for the call. Use `aimlapi#models` to discover ids (it reports " +
            "the live roster, so no model list is baked in here) and " +
            "`aimlapi#images/generations` for pictures.",
        docsUrl: "https://docs.aimlapi.com/api-references/text-models-llm",
        categories: ["text-generation"],
        notes: [
            "Non-streaming only: the run returns one complete response.",
            "`max_tokens` is required here so the pre-run hold is bounded; " +
            "the bill is the gateway's reported charge, which is normally " +
            "far below the hold.",
            "The hold is a connector-owned CEILING (see the doc comment on " +
            "`estimate`), not a vendor-published rate: AI/ML API publishes " +
            "no machine-readable price list, so the hold is deliberately " +
            "generous and the settle trues down.",
            "Model capabilities (vision, tools, structured output, " +
            "reasoning) vary per model — `aimlapi#models` carries each " +
            "row's own docs link.",
        ],
    },
    request: { method: "POST", path: "/chat/completions" },
    input: {
        schema: {
            // PRIMARY limiting knob (D25): the estimate's whole basis.
            // `n` is a behavior knob whose vendor default is 1 (verified
            // live 2026-10-15: an omitted `n` returns one choice), so it
            // is materialized at the binding and the estimate can read it.
            body: zChatCompletionsBody.required({ max_tokens: true }).extend({
                n: zChatCompletionsBody.shape.n.unwrap().default(1),
            }),
        },
    },
    usage: {
        model: {
            kind: UsageModelKind.PER_UNIT,
            unit: Unit.CREDIT,
            label: "gateway credits",
            description: "AI/ML API credits, the gateway's own billing " +
                "unit, fixed at $0.0000005 each",
            consumes: { credit: "default", amount: 0.0000005 },
        },
        /**
         * CEILING PIN, in gateway credits. This is the connector's own
         * conservative bound, NOT a rate AI/ML API publishes — the gateway
         * exposes no price field on `/v1/models`, no per-model price in
         * `docs-json`, and no pricing endpoint (checked 2026-10-15), so
         * there is no card to pin and no card to drift against. The hold
         * is set above the dearest model on the gateway instead:
         *   - input at $200 / 1M tokens = 400 credits per token;
         *   - output at $800 / 1M tokens = 1,600 credits per token.
         * Priced over:
         *   - caller-sent input: UTF-8 bytes of text parts, assistant
         *     `tool_calls`, `tools` and `response_format` (byte-level BPE
         *     spends >= 1 byte per token, so bytes bound tokens);
         *   - 1,000 tokens of gateway-side prompt overhead;
         *   - 8,000 tokens per image part (vision models bill images as
         *     prompt tokens; the inline base64 bytes are NOT counted as
         *     text);
         *   - `max_tokens` x `n` at the output rate.
         * The settle replaces all of this with the reported charge, so an
         * over-generous hold costs a caller nothing but headroom.
         */
        estimate: ({ data }) => {
            const body = data.input.body;
            const texts = [""];
            let images = 0;
            for (const message of body.messages) {
                const content = "content" in message ? message.content : "";
                if (typeof content === "string") texts.push(content);
                else if (Array.isArray(content)) {
                    for (const part of content) {
                        if (part.type === "text") texts.push(part.text);
                        else images += 1;
                    }
                }
                if ("tool_calls" in message && message.tool_calls) {
                    texts.push(JSON.stringify(message.tool_calls));
                }
            }
            if (body.tools) texts.push(JSON.stringify(body.tools));
            if (body.response_format) {
                texts.push(JSON.stringify(body.response_format));
            }
            let bytes = 0;
            for (const text of texts) {
                for (const ch of text) {
                    const cp = ch.codePointAt(0) ?? 0;
                    bytes += cp <= 0x7f
                        ? 1
                        : cp <= 0x7ff
                        ? 2
                        : cp <= 0xffff
                        ? 3
                        : 4;
                }
            }
            const inputTokens = bytes + 1_000 + images * 8_000;
            return {
                counts: {
                    "CREDIT": inputTokens * 400 +
                        body.max_tokens * body.n * 1_600,
                },
            };
        },
        /** The gateway's own credit meter, read off the RAW envelope
         *  (`meta.usage.credits_used`, before the provider consolidate
         *  plucks that node out). Absent ⇒ 0: money follows evidence. */
        evidence: ({ data, utils }) => {
            const meter = utils.json.optionalGet(data.output, "$.meta.usage");
            const credits = meter === undefined || meter === null
                ? 0
                : utils.json.optionalNum(meter, "$.credits_used") ?? 0;
            return { counts: { "CREDIT": credits } };
        },
    },
});
