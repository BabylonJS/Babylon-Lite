import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, normalizePath, type Plugin } from "vite";

import { demoOwnsBundleFile } from "../../../scripts/demo-bundle-name";
import { createLiteCodeSplitting, litePackageResolverPlugin, resolveLitePackageSpecifier, terserPropertyManglePlugin } from "../../../scripts/bundle-scenes-core";
import { compareLiteErrorFiles, isDeferredLiteErrorFile } from "../../../scripts/lite-error-plugin";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("bundle tooling correctness", () => {
    it("assigns optional accessibility error codes after core errors", () => {
        const root = join(tmpdir(), "lite-error-order");
        const core = join(root, "scene/scene-core.ts");
        const tree = join(root, "accessibility/accessibility-tree.ts");
        const twin = join(root, "scene/scene-html-twin.ts");

        expect(isDeferredLiteErrorFile(root, tree)).toBe(true);
        expect(isDeferredLiteErrorFile(root, twin)).toBe(true);
        expect(isDeferredLiteErrorFile(root, core)).toBe(false);
        expect([tree, core, twin].sort((a, b) => compareLiteErrorFiles(root, a, b))[0]).toBe(core);
    });

    it("keeps a loaded chunk byte-identical when an unrelated chunk is minified first", async () => {
        const root = mkdtempSync(join(tmpdir(), "lite-mangle-identifiers-"));
        tempDirs.push(root);
        writeFileSync(join(root, "loaded.js"), "const sharedIdentifier=globalThis.value;export function read(){return sharedIdentifier;}");
        writeFileSync(
            join(root, "unloaded.js"),
            "const extraIdentifier=globalThis.extra,sharedIdentifier=globalThis.value;export function other(){return extraIdentifier+sharedIdentifier;}"
        );
        const loadedCode = async (includeUnloaded: boolean): Promise<string> => {
            const input: Record<string, string> = {};
            if (includeUnloaded) {
                input["a-unloaded"] = join(root, "unloaded.js");
            }
            input["z-loaded"] = join(root, "loaded.js");
            const result = await build({
                root,
                configFile: false,
                publicDir: false,
                logLevel: "silent",
                plugins: [
                    {
                        name: "assert-fixture-chunk-order",
                        generateBundle(_options, bundle) {
                            const first = Object.values(bundle).find((chunk) => chunk.type === "chunk");
                            expect(first?.fileName).toBe(includeUnloaded ? "a-unloaded.mjs" : "z-loaded.mjs");
                        },
                    },
                    terserPropertyManglePlugin(),
                ],
                build: {
                    write: false,
                    minify: false,
                    rollupOptions: {
                        input,
                        preserveEntrySignatures: "strict",
                        output: { format: "es", entryFileNames: "[name].mjs" },
                    },
                },
            });
            if (Array.isArray(result) || !("output" in result)) {
                throw new Error("Expected one completed fixture build.");
            }
            const loaded = result.output.find((chunk) => chunk.fileName === "z-loaded.mjs");
            if (!loaded || loaded.type !== "chunk") {
                throw new Error(`The loaded fixture chunk is missing: ${result.output.map((chunk) => chunk.fileName).join(", ")}`);
            }
            return loaded.code;
        };

        expect(await loadedCode(true)).toBe(await loadedCode(false));
    });

    it("shares mangled object properties across independent ESM chunks", async () => {
        const root = mkdtempSync(join(tmpdir(), "lite-mangle-properties-"));
        tempDirs.push(root);
        const outDir = join(root, "out");
        writeFileSync(
            join(root, "entry.js"),
            'export async function run(){const state={_count:40,_extra:2};const feature=await import("./feature.js");return feature.read(state);}'
        );
        writeFileSync(join(root, "feature.js"), "export function read(state){return state._extra*100+state._count;}");

        await build({
            root,
            configFile: false,
            publicDir: false,
            logLevel: "silent",
            plugins: [terserPropertyManglePlugin()],
            build: {
                outDir,
                emptyOutDir: true,
                minify: false,
                rollupOptions: {
                    input: join(root, "entry.js"),
                    preserveEntrySignatures: "strict",
                    output: { format: "es", entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" },
                },
            },
        });

        const entry = (await import(pathToFileURL(join(outDir, "entry.mjs")).href)) as { run(): Promise<number> };
        await expect(entry.run()).resolves.toBe(240);
    });

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
        expect(demoOwnsBundleFile("racer.js.map", "racer", slugs)).toBe(true);
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

    it("resolves root and deep babylon-lite requests to Vite-normalized paths", () => {
        const root = mkdtempSync(join(tmpdir(), "lite-package-resolver-"));
        tempDirs.push(root);
        const sourceDir = join(root, "src");
        const libDir = join(root, "lib");
        const windowsStyleDir = join(root, "windows\\style\\src");
        mkdirSync(join(sourceDir, "shader"), { recursive: true });
        mkdirSync(join(libDir, "shader"), { recursive: true });
        mkdirSync(join(windowsStyleDir, "feature"), { recursive: true });
        writeFileSync(join(sourceDir, "index.ts"), "");
        writeFileSync(join(sourceDir, "shader/wgsl.ts"), "");
        writeFileSync(join(libDir, "index.js"), "");
        writeFileSync(join(libDir, "shader/wgsl.js"), "");
        writeFileSync(join(windowsStyleDir, "index.ts"), "");
        writeFileSync(join(windowsStyleDir, "feature/deep.ts"), "");

        expect(resolveLitePackageSpecifier("babylon-lite", sourceDir)).toBe(normalizePath(join(sourceDir, "index.ts")));
        expect(resolveLitePackageSpecifier("babylon-lite/shader/wgsl.js", sourceDir)).toBe(normalizePath(join(sourceDir, "shader/wgsl.ts")));
        expect(resolveLitePackageSpecifier("babylon-lite/shader/wgsl", libDir)).toBe(normalizePath(join(libDir, "shader/wgsl.js")));
        expect(resolveLitePackageSpecifier("babylon-lite?worker", libDir)).toBe(normalizePath(join(libDir, "index.js")) + "?worker");
        expect(resolveLitePackageSpecifier("babylon-lite", windowsStyleDir)).toBe(normalizePath(join(windowsStyleDir, "index.ts")));
        expect(resolveLitePackageSpecifier("babylon-lite/feature/deep.js", windowsStyleDir)).toBe(normalizePath(join(windowsStyleDir, "feature/deep.ts")));
        expect(resolveLitePackageSpecifier("babylon-lite-other", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/../outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/..\\outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite//outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/C:\\outside.js", libDir)).toBeNull();
        expect(resolveLitePackageSpecifier("babylon-lite/C:outside.js", libDir)).toBeNull();
    });

    it("uses one module identity for package and relative imports in parent and worker graphs", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "lite-package-identity-")));
        tempDirs.push(root);
        const sourceDir = join(root, "src");
        mkdirSync(join(sourceDir, "feature"), { recursive: true });
        writeFileSync(join(sourceDir, "index.ts"), "export const rootValue = 1;");
        writeFileSync(join(sourceDir, "feature/deep.ts"), "export const deepValue = 2;");

        const imports = [
            'import { rootValue as packageRoot } from "babylon-lite";',
            'import { rootValue as relativeRoot } from "./src/index.ts";',
            'import { deepValue as packageDeep } from "babylon-lite/feature/deep.js";',
            'import { deepValue as relativeDeep } from "./src/feature/deep.ts";',
        ];
        writeFileSync(
            join(root, "entry.ts"),
            [
                ...imports,
                'new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });',
                "export const total = packageRoot + relativeRoot + packageDeep + relativeDeep;",
            ].join("\n")
        );
        writeFileSync(join(root, "worker.ts"), [...imports, "self.postMessage(packageRoot + relativeRoot + packageDeep + relativeDeep);"].join("\n"));

        const parentModuleIds = new Set<string>();
        const workerModuleIds = new Set<string>();
        const trackModuleIdentities = (name: string, ids: Set<string>): Plugin => ({
            name,
            transform(_code, id) {
                if (/[/\\](?:index|deep)\.ts$/.test(id)) {
                    ids.add(id);
                }
            },
        });

        await build({
            root,
            configFile: false,
            publicDir: false,
            logLevel: "silent",
            plugins: [litePackageResolverPlugin(sourceDir), trackModuleIdentities("track-parent-source-module-identities", parentModuleIds)],
            worker: {
                format: "es",
                plugins: () => [litePackageResolverPlugin(sourceDir), trackModuleIdentities("track-worker-source-module-identities", workerModuleIds)],
            },
            build: {
                write: false,
                minify: false,
                rollupOptions: {
                    input: join(root, "entry.ts"),
                },
            },
        });

        const expectedIds = [normalizePath(join(sourceDir, "feature/deep.ts")), normalizePath(join(sourceDir, "index.ts"))].sort();
        expect([...parentModuleIds].sort()).toEqual(expectedIds);
        expect([...workerModuleIds].sort()).toEqual(expectedIds);
    });
});
