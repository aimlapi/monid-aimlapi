import { defineEndpoint, UsageModelKind } from "@shared/core";

/**
 * AI/ML API `GET /v1/models` — the live model roster, free.
 *
 * WHY this endpoint exists: the gateway's ids are vendor-prefixed and the
 * roster moves constantly (932 rows on 2026-10-15), so no doc in this
 * connector pins a model name. `aimlapi#chat/completions` and
 * `aimlapi#images/generations` take whatever id the caller read here.
 *
 * WHY the output is projected: one unfiltered call returns ~510 KB mixing
 * every endpoint family, and the ONLY thing that distinguishes them is the
 * `type` field:
 *   - `openai/chat-completions` (365 rows) and `anthropic/messages` (30) —
 *     both callable at `/chat/completions`, so they are ONE chat family;
 *   - `openai/image-generations` (125) — callable at
 *     `/images/generations`;
 *   - `internal/*`, `openai/embeddings`, `openai/responses/submit`,
 *     `anthropic/batches*`, … — neither, and not callable through this
 *     connector.
 * A model id may appear ONCE PER FAMILY, so the two chat types must be
 * MERGED BY ID, not concatenated: the 395 chat-family rows collapse to 365
 * distinct ids (verified live 2026-10-15 — every `anthropic/messages` id
 * is also published as `openai/chat-completions`). `fromResponse` does
 * exactly that and keeps each row's own label, developer and docs link.
 *
 * The gateway's own `?type=` filter is deliberately NOT exposed: it takes
 * ONE type, and one engine run is one request, so a caller-chosen type
 * would make the two-type chat family unrepresentable and silently empty
 * the arrays this endpoint's output contract promises.
 */
export default defineEndpoint({
    meta: {
        displayName: "AI/ML API Models",
        summary: "List the chat and image models this gateway can serve, " +
            "live.",
        description: "Read AI/ML API's live model roster and get back the " +
            "ids that are actually callable through this connector, split " +
            "by family: `chat` (usable with " +
            "`aimlapi#chat/completions`) and `image` (usable with " +
            "`aimlapi#images/generations`), each entry carrying the id, " +
            "the display name, the developer, the context length where " +
            "published and the model's own docs link. The gateway mixes " +
            "every endpoint family into one list and distinguishes them " +
            "only by an internal `type`, with the same id appearing under " +
            "more than one type — this endpoint resolves that and " +
            "de-duplicates. Free: no credits, and the underlying call " +
            "needs no key.",
        docsUrl: "https://docs.aimlapi.com/api-references/model-database",
        categories: ["text-generation", "image-generation"],
        notes: [
            "Free — the gateway bills nothing for the roster and reports " +
            "no meter on it.",
            "The upstream call works without a key; the connector still " +
            "sends one, because auth is where this provider attaches its " +
            "attribution headers.",
            "`counts.chatRows`/`counts.imageRows` are the raw row counts " +
            "and `counts.chat`/`counts.image` the de-duplicated ones — " +
            "when they differ, an id was published under two types.",
        ],
    },
    request: { method: "GET", path: "/models" },
    usage: { model: { kind: UsageModelKind.FREE } },
    output: {
        /**
         * Project the roster onto the two families this connector can
         * call, merging by id. `type` is the only discriminator the
         * gateway gives, and it is NOT a prefix test: `openai/embeddings`
         * and `openai/responses/submit` share the `openai/` prefix with
         * `openai/chat-completions` and are not chat.
         */
        fromResponse: ({ data, utils }) => {
            const rows = utils.json.optionalGet(data.output, "$.data");
            const chat = [];
            const image = [];
            const chatIds: string[] = [];
            const imageIds: string[] = [];
            let chatRows = 0;
            let imageRows = 0;
            if (Array.isArray(rows)) {
                for (const row of rows) {
                    if (
                        typeof row !== "object" || row === null ||
                        Array.isArray(row)
                    ) continue;
                    const id = row.id;
                    const type = row.type;
                    if (typeof id !== "string" || typeof type !== "string") {
                        continue;
                    }
                    const isChat = type === "openai/chat-completions" ||
                        type === "anthropic/messages";
                    const isImage = type === "openai/image-generations";
                    if (!isChat && !isImage) continue;
                    if (isChat) chatRows += 1;
                    else imageRows += 1;
                    const seen = isChat ? chatIds : imageIds;
                    if (seen.includes(id)) continue;
                    seen.push(id);
                    const info = row.info;
                    const described = typeof info === "object" &&
                        info !== null && !Array.isArray(info);
                    const entry = {
                        id,
                        name: described && typeof info.name === "string"
                            ? info.name
                            : id,
                        developer:
                            described && typeof info.developer === "string"
                                ? info.developer
                                : null,
                        contextLength: described &&
                                typeof info.contextLength === "number"
                            ? info.contextLength
                            : null,
                        docsUrl: described && typeof info.docsUrl === "string"
                            ? info.docsUrl
                            : null,
                    };
                    if (isChat) chat.push(entry);
                    else image.push(entry);
                }
            }
            return {
                counts: {
                    chat: chat.length,
                    chatRows,
                    image: image.length,
                    imageRows,
                },
                chat,
                image,
            };
        },
    },
});
