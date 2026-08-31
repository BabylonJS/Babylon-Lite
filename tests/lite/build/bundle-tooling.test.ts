import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

import { demoOwnsBundleFile } from "../../../scripts/demo-bundle-name";
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

        expect(demoOwnsBundleFile("fluid-worker-shared-abc123.js", "fluid-worker", slugs)).toBe(true);
        expect(demoOwnsBundleFile("fluid-worker-shared-abc123.js", "fluid", slugs)).toBe(false);
        expect(demoOwnsBundleFile("fluid-old-abc123.js", "fluid", slugs)).toBe(true);
        expect(demoOwnsBundleFile("racer.js", "racer", slugs)).toBe(true);
        expect(demoOwnsBundleFile("unrelated.js", "racer", slugs)).toBe(false);
    });

    it("recognizes support bundle files whose slug is not in the demo config", () => {
        const knownSlugs = ["fluid", "racer", "landing-bg"];

        expect(demoOwnsBundleFile("landing-bg-oldhash.js", "landing-bg", knownSlugs)).toBe(true);
    });

    it("keeps ownership exclusive regardless of which prefix-related demo is being built", () => {
        const knownSlugs = ["landing", "racer", "landing-bg"];

        expect(demoOwnsBundleFile("landing-bg-oldhash.js", "landing-bg", knownSlugs)).toBe(true);
        expect(demoOwnsBundleFile("landing-bg-oldhash.js", "landing", knownSlugs)).toBe(false);
        expect(demoOwnsBundleFile("landing-oldhash.js", "landing", knownSlugs)).toBe(true);
        expect(demoOwnsBundleFile("landing-oldhash.js", "landing-bg", knownSlugs)).toBe(false);
    });
});
