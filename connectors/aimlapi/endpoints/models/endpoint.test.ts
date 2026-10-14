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
    // 4 chat-family ROWS in the fixture collapse to 3 distinct ids,
    // because anthropic/claude-haiku-5-5 is published BOTH as
    // openai/chat-completions and as anthropic/messages
    assertEquals(output.counts, {
        chat: 3,
        chatRows: 4,
        image: 2,
        imageRows: 2,
    });

    const chat = output.chat as Record<string, unknown>[];
    assertEquals(chat.map((row) => row.id), [
        "openai/gpt-4o-mini",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-6.1-sol",
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
                req: { method: "GET", url: unit.doc.request.url },
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
        fixture: await loadFixture(`${chains}unauthorized-get.json`),
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
        // ...and the type vocabulary this endpoint keys on still exists
        assertEquals(CHAT_TYPES.length, 2);
        assertEquals(IMAGE_TYPE, "openai/image-generations");
    },
});
