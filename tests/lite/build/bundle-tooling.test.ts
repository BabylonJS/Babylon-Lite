import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

import { demoSlugForBundleFile } from "../../../scripts/demo-bundle-name";
import { terserPropertyManglePlugin } from "../../../scripts/bundle-scenes-core";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("bundle tooling correctness", () => {
    it("preserves underscore-prefixed ESM exports referenced through a dynamic-import namespace", async () => {
        const root = mkdtempSync(join(tmpdir(), "lite-mangle-exports-"));
        tempDirs.push(root);
        const outDir = join(root, "out");
        writeFileSync(join(root, "entry.js"), 'export async function run(){const feature=await import("./feature.js");return feature._apply();}');
        writeFileSync(join(root, "feature.js"), "export const _apply=()=>42;");

        await build({
            root,
            configFile: false,
            publicDir: false,
            logLevel: "silent",
            plugins: [terserPropertyManglePlugin()],
            build: {
                outDir,
                emptyOutDir: true,
                minify: "esbuild",
                rollupOptions: {
                    input: join(root, "entry.js"),
                    preserveEntrySignatures: "strict",
                    output: {
                        format: "es",
                        entryFileNames: "entry.mjs",
                        chunkFileNames: "[name]-[hash].mjs",
                    },
                },
            },
        });

        const entry = (await import(`${pathToFileURL(join(outDir, "entry.mjs")).href}?test=${Date.now()}`)) as { run(): Promise<number> };
        await expect(entry.run()).resolves.toBe(42);
    });

    it("assigns prefix-related bundle files to the longest matching demo slug", () => {
        const slugs = ["fluid", "fluid-worker", "racer"];

        expect(demoSlugForBundleFile("fluid-worker-shared-abc123.js", slugs)).toBe("fluid-worker");
        expect(demoSlugForBundleFile("fluid-old-abc123.js", slugs)).toBe("fluid");
        expect(demoSlugForBundleFile("racer.js", slugs)).toBe("racer");
        expect(demoSlugForBundleFile("unrelated.js", slugs)).toBeUndefined();
    });
});
