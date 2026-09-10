import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ignoredScenePayloadCompatibilityBytes, isIgnoredScenePayloadModule, summarizeRuntimeBundle, type RuntimeJsPayload } from "../../../scripts/bundle-size-accounting";

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

describe("ignored scene payload accounting", () => {
    it("recognizes only checked-in NME and NPE scene payload modules", () => {
        expect(isIgnoredScenePayloadModule("/repo/lab/lite/src/shared/scene263-npe.ts")).toBe(true);
        expect(isIgnoredScenePayloadModule("C:\\repo\\lab\\lite\\src\\shared\\scene72-nme.ts?raw")).toBe(true);
        expect(isIgnoredScenePayloadModule("/repo/packages/babylon-lite/src/particle/node/npe-parser.ts")).toBe(false);
    });

    it("uses a stable unminified transpilation rather than source formatting or final Oxc output", () => {
        const dir = mkdtempSync(join(tmpdir(), "lite-payload-size-"));
        try {
            const file = join(dir, "scene263-npe.ts");
            writeFileSync(file, '/** data */\nexport const DATA = { "value": 42 } as const;\nexport const UNUSED = 99;\n');
            expect(ignoredScenePayloadCompatibilityBytes(`${file}?raw`, ["DATA"])).toBe(28);
            expect(ignoredScenePayloadCompatibilityBytes(file, ["DATA", "UNUSED"])).toBeGreaterThan(28);
            expect(ignoredScenePayloadCompatibilityBytes(join(dir, "ordinary.ts"), ["DATA"])).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
