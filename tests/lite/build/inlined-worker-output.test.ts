import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ensureLibBuilt, LIB_ENTRY } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);

describe("inlined worker package output", () => {
    it("ships the splat sort worker string fully minified", () => {
        const chunksDirectory = resolve(dirname(LIB_ENTRY), "_chunks");
        const [workerChunk, ...extraChunks] = readdirSync(chunksDirectory).filter((name) => /^splat-sort-worker-.*\.js$/.test(name));
        expect(workerChunk).toBeDefined();
        expect(extraChunks).toEqual([]);

        const code = readFileSync(join(chunksDirectory, workerChunk!), "utf8");
        const workerLiteral = /var jsContent = ("(?:[^"\\]|\\.)*");/.exec(code)?.[1];
        expect(workerLiteral).toBeDefined();

        const workerSource = JSON.parse(workerLiteral!) as string;
        expect(workerSource).toContain("self.postMessage");
        expect(workerSource.trimEnd()).not.toMatch(/[\n\t]/);
    });
});
