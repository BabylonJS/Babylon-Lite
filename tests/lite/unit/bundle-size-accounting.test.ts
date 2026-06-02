import { describe, expect, it } from "vitest";

import { summarizeRuntimeBundle, type RuntimeJsPayload } from "../../../scripts/bundle-size-accounting";

// bundleInfoDir/scene that has no `${scene}.json` so ignored-module accounting is a no-op.
const NO_INFO_DIR = "/__nonexistent-bundle-info__";
const SCENE = "scene-test";

function payload(file: string, body: string): RuntimeJsPayload {
    return { file, body: Buffer.from(body, "utf-8") };
}

describe("summarizeRuntimeBundle", () => {
    it("does not double-count a chunk fetched more than once during a page load", () => {
        const a = payload("chunk-a.js", "a".repeat(1000));
        const b = payload("chunk-b.js", "b".repeat(2000));

        const once = summarizeRuntimeBundle([a, b], NO_INFO_DIR, SCENE);
        // Same set of distinct chunks, but chunk-a is re-fetched twice.
        const refetched = summarizeRuntimeBundle([a, b, a, a], NO_INFO_DIR, SCENE);

        expect(refetched.fetchedRawBytes).toBe(once.fetchedRawBytes);
        expect(refetched.rawBytes).toBe(once.rawBytes);
        expect(refetched.gzipBytes).toBe(once.gzipBytes);
        expect(refetched.fetchedRawBytes).toBe(3000);
    });
});
