import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

import { demoOwnsBundleFile } from "../../../scripts/demo-bundle-name";
import { createLiteCodeSplitting, resolveLitePackageSpecifier, terserPropertyManglePlugin } from "../../../scripts/bundle-scenes-core";

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

    it("coalesces the initial graph while preserving the text-shaper vendor boundary", async () => {
        const root = mkdtempSync(join(tmpdir(), "lite-rolldown-groups-"));
        tempDirs.push(root);
        mkdirSync(join(root, "text-shaper-runtime"));
        writeFileSync(join(root, "shared.js"), 'export const sharedMarker="shared-marker";');
        writeFileSync(join(root, "initial.js"), 'import {sharedMarker} from "./shared.js"; export const initialMarker="initial-marker-"+sharedMarker;');
        writeFileSync(join(root, "text-shaper-runtime/vendor.js"), 'export const vendorMarker="vendor-marker";');
        writeFileSync(
            join(root, "feature.js"),
            'import {sharedMarker} from "./shared.js"; import {vendorMarker} from "./text-shaper-runtime/vendor.js"; export const lazyMarker="lazy-marker-"+sharedMarker+vendorMarker;'
        );
        writeFileSync(join(root, "entry.js"), 'import {initialMarker} from "./initial.js"; export const initial=initialMarker; export const load=()=>import("./feature.js");');

        const result = (await build({
            root,
            configFile: false,
            publicDir: false,
            logLevel: "silent",
            build: {
                write: false,
                minify: "oxc",
                rolldownOptions: {
                    input: join(root, "entry.js"),
                    preserveEntrySignatures: "allow-extension",
                    output: {
                        format: "es",
                        entryFileNames: "entry.js",
                        chunkFileNames: "[name]-[hash].js",
                        codeSplitting: createLiteCodeSplitting(),
                    },
                },
            },
        })) as unknown as { output: { type: string; fileName: string; code?: string; isEntry?: boolean }[] };

        const chunks = result.output.filter((entry) => entry.type === "chunk");
        const entry = chunks.find((chunk) => chunk.isEntry);
        const textShaper = chunks.find((chunk) => chunk.fileName.startsWith("text-shaper-"));
        expect(chunks).toHaveLength(3);
        expect(entry?.code).toContain("initial-marker-");
        expect(entry?.code).toContain("shared-marker");
        expect(entry?.code).not.toContain("vendor-marker");
        expect(textShaper?.code).toContain("vendor-marker");
    });

    it("resolves root and deep babylon-lite requests exactly for source and built trees", () => {
        const root = mkdtempSync(join(tmpdir(), "lite-package-resolver-"));
        tempDirs.push(root);
        const sourceDir = join(root, "src");
        const libDir = join(root, "lib");
        mkdirSync(join(sourceDir, "shader"), { recursive: true });
        mkdirSync(join(libDir, "shader"), { recursive: true });
        writeFileSync(join(sourceDir, "index.ts"), "");
        writeFileSync(join(sourceDir, "shader/wgsl.ts"), "");
        writeFileSync(join(libDir, "index.js"), "");
        writeFileSync(join(libDir, "shader/wgsl.js"), "");

        expect(resolveLitePackageSpecifier("babylon-lite", sourceDir)).toBe(join(sourceDir, "index.ts"));
        expect(resolveLitePackageSpecifier("babylon-lite/shader/wgsl.js", sourceDir)).toBe(join(sourceDir, "shader/wgsl.ts"));
        expect(resolveLitePackageSpecifier("babylon-lite/shader/wgsl", libDir)).toBe(join(libDir, "shader/wgsl.js"));
        expect(resolveLitePackageSpecifier("babylon-lite?worker", libDir)).toBe(join(libDir, "index.js") + "?worker");
        expect(resolveLitePackageSpecifier("babylon-lite-other", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/../outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/..\\outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite//outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/C:\\outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/C:outside.js", libDir)).toBeNull();
    });
});
