import { z } from "zod";

/**
 * AI/ML API `GET /v1/models` query params.
 *
 * `include` is the gateway's own expansion knob and the reason this
 * endpoint has an input at all: WITHOUT it the roster carries no prices,
 * and with `include=pricing` every row gains a `pricing` object. The value
 * is a LITERAL rather than an open string, pinned to the one expansion
 * this endpoint's output contract is built on:
 *
 *   - `all` additionally returns `capabilities`, `modalities` and
 *     `providers` and triples the payload (1.66 MB against 0.52 MB bare,
 *     measured 2026-10-15) for fields nothing here projects;
 *   - an unrecognized value is ignored by the gateway, which would
 *     silently return rows with no `pricing` and quietly null every price
 *     this endpoint promises.
 *
 * It is `.default()`ed, so a caller never has to pass it and the compiled
 * binding materializes it on the wire. The parameter is undocumented
 * upstream — `docs-json` declares no query parameters for this path — so
 * it is pinned here and the live `test:live` run is what proves it still
 * behaves.
 */
export const zModelsQueryParams = z.object({
    include: z.literal("pricing").default("pricing").describe(
        "Gateway expansion to request. Only `pricing` is accepted here: " +
            "it is what makes each row carry its rate card, and it is the " +
            "expansion this endpoint's output is built on.",
    ),
});
