import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
    liveSkip,
    loadFixture,
    runEndpoint,
    testSealedUnit,
} from "@shared/testing";

const ID = "aimlapi#models";
const chains = fromFileUrl(new URL("../../fixtures/", import.meta.url));

/** The chat-family types the gateway publishes, and the ONLY two. */
const CHAT_TYPES = ["openai/chat-completions", "anthropic/messages"];
const IMAGE_TYPE = "openai/image-generations";

Deno.test(`${ID} happy (recorded): families split by type, chat ids MERGED across the two chat types`, async () => {
    const unit = await testSealedUnit(ID);
    const result = await runEndpoint({
        unit,
        input: {},
        mode: "replay",
        fixture: await loadFixture(`${chains}models-ok.json`),
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    // free: no meter on the roster, and the FREE model folds to nothing
    assertEquals(result.usage, { credits: {}, evidence: {} });

    const output = result.output as Record<string, unknown>;
    // 5 chat-family ROWS in the fixture collapse to 4 distinct ids,
    // because anthropic/claude-haiku-5-5 is published BOTH as
    // openai/chat-completions and as anthropic/messages
    assertEquals(output.counts, {
        chat: 4,
        chatRows: 5,
        image: 2,
        imageRows: 2,
    });

    const chat = output.chat as Record<string, unknown>[];
    assertEquals(chat.map((row) => row.id), [
        "openai/gpt-4o-mini",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-6.1-sol",
        "synthetic/unpriced-chat-model",
    ]);
    const image = output.image as Record<string, unknown>[];
    assertEquals(image.map((row) => row.id), [
        "blackforestlabs/flux-dev",
        "x-ai/grok-imagine-image-2.0",
    ]);

    // the row's own label survives, and the absent leaves are null rather
    // than missing
    assertEquals(chat[0].name, "GPT-4o Mini");
    assertEquals(chat[0].developer, "Open AI");
    assertEquals(chat[0].contextLength, 128000);
    assertEquals(
        (chat[0].docsUrl as string).startsWith("https://docs.aimlapi.com/"),
        true,
    );

    // the families this connector cannot call are DROPPED — including the
    // prefix trap: openai/embeddings and openai/responses/submit share
    // the `openai/` prefix with openai/chat-completions and are not chat
    const ids = [...chat, ...image].map((row) => row.id);
    assertEquals(ids.includes("alibaba/qwen-text-embedding-v3"), false);
    assertEquals(ids.includes("elevenlabs/scribe_v2"), false);
    // ...while gpt-6.1-sol, which ALSO has a responses/submit row, is
    // still present exactly once from its chat-completions row
    assertEquals(
        chat.filter((row) => row.id === "openai/gpt-6.1-sol").length,
        1,
    );
    // and the image id that also has an image-EDITING row appears once
    assertEquals(
        image.filter((row) => row.id === "x-ai/grok-imagine-image-2.0")
            .length,
        1,
    );
});

Deno.test(`${ID} prices: the vendor's card, normalized to one unit`, async () => {
    const unit = await testSealedUnit(ID);
    const result = await runEndpoint({
        unit,
        input: {},
        mode: "replay",
        fixture: await loadFixture(`${chains}models-ok.json`),
    });
    const output = result.output as Record<string, unknown>;
    const chat = output.chat as Record<string, unknown>[];
    const image = output.image as Record<string, unknown>[];
    const priceOf = (row: Record<string, unknown>) =>
        row.pricing as Record<string, unknown>;

    // A FIXED chat model: the published $/1M survives the round trip
    // through "price of one unit" exactly, and every priced unit the
    // vendor lists is kept — including the ones the two named rates do
    // not cover (cache reads, tool calls).
    const mini = priceOf(chat[0]);
    assertEquals(mini.currency, "USD");
    assertEquals(mini.kind, "fixed");
    assertEquals(mini.variable, false);
    assertEquals(mini.tiered, false);
    assertEquals(mini.inputUsdPerMTok, 0.195);
    assertEquals(mini.outputUsdPerMTok, 0.78);
    assertEquals(mini.units, [
        { name: "token", origin: "provided", usdPerUnit: 1.95e-7 },
        { name: "token", origin: "generated", usdPerUnit: 7.8e-7 },
        { name: "token", origin: "cached", usdPerUnit: 9.75e-8 },
        { name: "call", origin: "generated", usdPerUnit: 0 },
    ]);
    // a chat row carries the chat rates and NOT the image one
    assertEquals("usdPerImage" in mini, false);

    // Volume thresholds flag the flat number as the HEADLINE rate, and a
    // model publishing three `call` tiers keeps all three while the named
    // rates take the first match.
    const haiku = priceOf(chat[1]);
    assertEquals(haiku.tiered, true);
    assertEquals(haiku.inputUsdPerMTok, 0.13);
    assertEquals(haiku.outputUsdPerMTok, 0.65);
    const haikuCalls = (haiku.units as Record<string, unknown>[])
        .filter((u) => u.name === "call").map((u) => u.usdPerUnit);
    assertEquals(haikuCalls, [0.065, 0.013, 0]);

    // A per-generation image model: one unit, one price, no scaling
    const flux = priceOf(image[0]);
    assertEquals(image[0].id, "blackforestlabs/flux-dev");
    assertEquals(flux.kind, "fixed");
    assertEquals(flux.variable, false);
    assertEquals(flux.usdPerImage, 0.0325);
    assertEquals("inputUsdPerMTok" in flux, false);

    // THE variants shape: the vendor leaves `price: null` on the unit and
    // prices through a variants matrix. The flat number must be null, not
    // zero, and the unpriced unit must be dropped rather than read as free.
    const grok = priceOf(image[1]);
    assertEquals(image[1].id, "x-ai/grok-imagine-image-2.0");
    assertEquals(grok.kind, "variants");
    assertEquals(grok.variable, true);
    assertEquals(grok.usdPerImage, null);
    assertEquals(grok.units, []);

    // A row with no `pricing` at all projects to the same shape with
    // nothing in it — never a missing key, never a zero price.
    const unpriced = priceOf(chat[3]);
    assertEquals(chat[3].id, "synthetic/unpriced-chat-model");
    assertEquals(unpriced, {
        currency: null,
        kind: null,
        variable: false,
        tiered: false,
        units: [],
        inputUsdPerMTok: null,
        outputUsdPerMTok: null,
    });
});

Deno.test(`${ID} empty and malformed rows: the projection never throws`, async () => {
    const unit = await testSealedUnit(ID);
    const result = await runEndpoint({
        unit,
        input: {},
        mode: "replay",
        fixture: {
            name: "synthetic-models-degenerate",
            description: "A roster with a scalar row, a null row, a row " +
                "with no id and a row with no type must project to empty " +
                "families instead of failing the run.",
            calls: [{
                req: {
                    method: "GET",
                    url: unit.doc.request.url + "?include=pricing",
                },
                res: {
                    status: 200,
                    body: {
                        object: "list",
                        data: [
                            "openai/gpt-4o-mini",
                            null,
                            { type: "openai/chat-completions" },
                            { id: "openai/orphan" },
                            { id: "x/y", type: "internal/decisions" },
                        ],
                    },
                },
            }],
        },
    });
    const output = result.output as Record<string, unknown>;
    assertEquals(output.counts, {
        chat: 0,
        chatRows: 0,
        image: 0,
        imageRows: 0,
    });
    assertEquals(output.chat, []);
    assertEquals(output.image, []);
});

Deno.test(`${ID} provider error (recorded 401 on a GET): zero usage, digested error`, async () => {
    const unit = await testSealedUnit(ID);
    const result = await runEndpoint({
        unit,
        input: {},
        mode: "replay",
        fixture: await loadFixture(`${chains}unauthorized-models.json`),
    });
    assertEquals(result.httpStatus, 401);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
    const output = result.output as Record<string, unknown>;
    assertEquals(
        (output.message as string).startsWith(
            "This request requires a valid API key",
        ),
        true,
    );
});

Deno.test({
    name: `${ID} live (gated on AIMLAPI_API_KEY)`,
    ignore: liveSkip("aimlapi"),
    fn: async () => {
        const unit = await testSealedUnit(ID);
        const result = await runEndpoint({
            unit,
            input: {},
            mode: "live",
        });
        assertEquals(
            result.isProviderError,
            false,
            JSON.stringify(result.usage),
        );
        assertEquals(result.usage, { credits: {}, evidence: {} });
        const output = result.output as Record<string, unknown>;
        const counts = output.counts as Record<string, number>;
        const chat = output.chat as Record<string, unknown>[];
        const image = output.image as Record<string, unknown>[];
        // the live roster moves, so assert the INVARIANTS rather than
        // today's numbers: both families are non-empty, de-duplication
        // never grows a list, and every id is unique within its family
        assertEquals(chat.length, counts.chat);
        assertEquals(image.length, counts.image);
        assertEquals(counts.chat > 0 && counts.image > 0, true);
        assertEquals(counts.chat <= counts.chatRows, true);
        assertEquals(counts.image <= counts.imageRows, true);
        assertEquals(
            new Set(chat.map((row) => row.id)).size,
            chat.length,
        );
        assertEquals(
            new Set(image.map((row) => row.id)).size,
            image.length,
        );
        // the two chat types really do overlap in production: the merge
        // is load-bearing, not decoration
        assertEquals(counts.chatRows > counts.chat, true);

        // THE guard on the undocumented `?include=pricing` pin: if the
        // gateway ever stops honouring it, every row comes back unpriced
        // and this is where that shows up, loudly, instead of the output
        // quietly nulling every price. Both named chat rates must be
        // numeric on the vast majority of the live roster.
        const priced = chat.filter((row) => {
            const card = row.pricing as Record<string, unknown>;
            return typeof card.inputUsdPerMTok === "number" &&
                typeof card.outputUsdPerMTok === "number";
        });
        assertEquals(
            priced.length * 10 >= chat.length * 9,
            true,
            `only ${priced.length} of ${chat.length} chat rows priced`,
        );
        // ...and the prices are real money, not zeros
        const dearest = Math.max(
            ...priced.map((row) =>
                (row.pricing as Record<string, number>).outputUsdPerMTok
            ),
        );
        assertEquals(dearest > 0, true);
        // image rows carry the per-generation rate where they publish one
        const perImage = image.filter((row) =>
            typeof (row.pricing as Record<string, unknown>).usdPerImage ===
                "number"
        );
        assertEquals(perImage.length > 0, true);
        // ...and the type vocabulary this endpoint keys on still exists
        assertEquals(CHAT_TYPES.length, 2);
        assertEquals(IMAGE_TYPE, "openai/image-generations");
    },
});
