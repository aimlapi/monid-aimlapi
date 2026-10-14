import { defineEndpoint, Unit, UsageModelKind } from "@shared/core";
import { zImagesGenerationsBody } from "./schema/inputs.ts";

/**
 * AI/ML API `POST /v1/images/generations` — text to image, across the
 * gateway's ~125 image models.
 *
 * Billing is the same story as chat: the response carries
 * `meta.usage: {credits_used, usd_spent}` (verified live 2026-10-15 —
 * `blackforestlabs/flux-dev` answered `{credits_used: 65000,
 * usd_spent: 0.0325}`, i.e. the same 2,000,000 credits per dollar), the
 * provider consolidate claims the dollars, and this doc meters the
 * gateway's own CREDIT so the derived fold reproduces the claim.
 * `usage.evidence` here is BYTE-IDENTICAL to the chat endpoint's and
 * therefore interns to one fnTable entry (asserted in
 * `endpoint.test.ts`) — the meter is a gateway-wide fact, not a
 * per-endpoint one.
 */
export default defineEndpoint({
    meta: {
        displayName: "AI/ML API Image Generation",
        summary: "Generate images with ~125 models — FLUX, GPT-Image, " +
            "Qwen-Image, Seedream, Imagen — behind one key.",
        description: "Generate images from a text prompt on AI/ML API. " +
            "Pick any image model the gateway serves by its prefixed id " +
            "(`blackforestlabs/flux-dev`, `openai/gpt-image-2`, " +
            "`alibaba/qwen-image-3`, `bytedance/seedream-5-0-pro`, …) and " +
            "pass whatever that model's own options are alongside " +
            "`prompt`: the gateway documents one request arm per model, so " +
            "model-specific keys (`size`, `quality`, `image_size`, " +
            "`aspect_ratio`, `num_inference_steps`, `seed`, …) ride " +
            "through untouched. The response is " +
            "`{data: [{url}]}` — hosted image URLs, not base64. Billed at " +
            "the gateway's own reported charge for the call. Discover ids " +
            "with `aimlapi#models` (its `image` array).",
        docsUrl: "https://docs.aimlapi.com/api-references/image-models",
        categories: ["image-generation"],
        notes: [
            "Only `model` and `prompt` are universal; every other field is " +
            "the chosen model's own and is passed through unvalidated. A " +
            "key a model does not know is rejected by the gateway with a " +
            "400 naming it.",
            "The count knob is spelled `n` on OpenAI-shaped models and " +
            "`num_images` on fal-shaped ones, and some models (e.g. " +
            "`google/gemini-nano-banana-2.1`) have none. Neither is " +
            "defaulted here: a default would be sent on the wire to " +
            "models that reject it.",
            "The hold is a connector-owned CEILING of $1.00 per image " +
            "(see `estimate`), not a vendor-published rate; the settle " +
            "trues down to the reported charge.",
        ],
    },
    request: { method: "POST", path: "/images/generations" },
    input: { schema: { body: zImagesGenerationsBody } },
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
         * CEILING PIN, in gateway credits: $1.00 per requested image =
         * 2,000,000 credits. As with chat, this is the connector's own
         * bound and NOT a published rate — AI/ML API exposes no price
         * anywhere machine-readable (checked 2026-10-15), and the dearest
         * image models cost a fraction of a dollar per image
         * (`flux-dev` measured at $0.0325), so a dollar is deliberate
         * headroom rather than an estimate of the mean.
         *
         * The count is the larger of the two spellings the gateway uses,
         * each falling back to the vendor default of 1 that every arm's
         * own schema declares — honest optionality: a model with no count
         * knob holds for exactly one image.
         */
        estimate: ({ data }) => {
            const body = data.input.body;
            const n = body.n === undefined ? 1 : body.n;
            const numImages = body.num_images === undefined
                ? 1
                : body.num_images;
            return {
                counts: {
                    "CREDIT": Math.max(n, numImages) * 2_000_000,
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
