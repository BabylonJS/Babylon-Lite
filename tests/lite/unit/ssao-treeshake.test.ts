import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

describe("SSAO root-entry opt-in", () => {
    it.each(["enableMaterialPlugins", "enablePbrMaterialPluginVertexData", "enablePbrSsao", "createGeometryRendererTask", "enableGeometryVelocity"])(
        "isolates optional plugin and velocity implementations (%s)",
        async (name) => {
            const result = await build({
                stdin: {
                    contents: `import { ${name} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))}; globalThis.usedExport=${name};`,
                    resolveDir: process.cwd(),
                    loader: "ts",
                },
                bundle: true,
                metafile: true,
                write: false,
                format: "esm",
                platform: "browser",
                packages: "external",
                external: ["*?worker&inline"],
                loader: { ".wgsl": "text", ".wasm": "file" },
                outdir: ".ao-reference-cache/bundle-check",
                logLevel: "silent",
                minify: true,
                target: "esnext",
            });
            const retained = Object.values(result.metafile!.outputs).some((output) =>
                Object.entries(output.inputs).some(([path, input]) => path.endsWith("pbr-plugin-passes.ts") && input.bytesInOutput > 0)
            );
            expect(retained).toBe(name === "enablePbrSsao");
            const velocity = Object.values(result.metafile!.outputs).some((output) =>
                Object.entries(output.inputs).some(([path, input]) => path.endsWith("pbr-geometry-velocity.ts") && input.bytesInOutput > 0)
            );
            expect(velocity).toBe(name === "enableGeometryVelocity");
        }
    );
    it.each(["createSsaoTask", "enableSsaoHalfResolution"])("isolates whole-pipeline reduction behind the Half enabler (%s)", async (name) => {
        const result = await build({
            stdin: {
                contents: `import { ${name} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))}; globalThis.usedExport=${name};`,
                resolveDir: process.cwd(),
                loader: "ts",
            },
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            packages: "external",
            external: ["*?worker&inline"],
            loader: { ".wgsl": "text", ".wasm": "file" },
            outdir: ".ao-reference-cache/bundle-check",
            logLevel: "silent",
            minify: true,
            target: "esnext",
        });
        const code = result.outputFiles[0]!.text;
        expect(code.includes("ssao-half-pipeline-prepare")).toBe(name === "enableSsaoHalfResolution");
        expect(code.includes("ssao-half-pipeline-upsample")).toBe(name === "enableSsaoHalfResolution");
        expect(code).not.toContain("ssao-half-upsample");
        expect(code).not.toContain("PIXEL_STRIDE");
    });
    it.each([false, true])("retains motion-mask resources and queries only when explicitly enabled (%s)", async (enabled) => {
        const name = enabled ? "enableSsaoMotionPruning" : "createSsaoTask";
        const result = await build({
            stdin: {
                contents: `import { ${name} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))}; globalThis.usedExport=${name};`,
                resolveDir: process.cwd(),
                loader: "ts",
            },
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            packages: "external",
            external: ["*?worker&inline"],
            loader: { ".wgsl": "text", ".wasm": "file" },
            outdir: ".ao-reference-cache/bundle-check",
            logLevel: "silent",
            minify: true,
            splitting: false,
            target: "esnext",
        });
        const code = result.outputFiles[0]!.text;
        expect(code.includes("ssao-object-motion-mask")).toBe(enabled);
        expect(code.includes("markMovingTile")).toBe(enabled);
        expect(code.includes("movingCaster")).toBe(enabled);
    });
    it.each([false, true])("retains half-resolution preparation only when explicitly enabled (%s)", async (enabled) => {
        const name = enabled ? "enableSsaoHalfResolution" : "createSsaoTask";
        const result = await build({
            stdin: {
                contents: `import { ${name} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))}; globalThis.usedExport=${name};`,
                resolveDir: process.cwd(),
                loader: "ts",
            },
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            packages: "external",
            external: ["*?worker&inline"],
            loader: { ".wgsl": "text", ".wasm": "file" },
            outdir: ".ao-reference-cache/bundle-check",
            logLevel: "silent",
            minify: true,
            splitting: false,
            target: "esnext",
        });
        expect(result.outputFiles[0]!.text.includes("ssao-half-pipeline-upsample")).toBe(enabled);
    });
    it.each([false, true])("includes default reconstruction only when SSAO is imported (%s)", async (enabled) => {
        const name = enabled ? "createSsaoTask" : "createEngine";
        const result = await build({
            stdin: {
                contents: `import { ${name} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))}; globalThis.usedExport=${name};`,
                resolveDir: process.cwd(),
                loader: "ts",
            },
            bundle: true,
            metafile: true,
            write: false,
            format: "esm",
            platform: "browser",
            packages: "external",
            external: ["*?worker&inline"],
            loader: { ".wgsl": "text", ".wasm": "file" },
            outdir: ".ao-reference-cache/bundle-check",
            logLevel: "silent",
            minify: true,
            splitting: false,
            target: "esnext",
        });
        const code = result.outputFiles[0]!.text;
        expect(code.includes("ssao-history-geometry-0")).toBe(enabled);
        expect(code.includes("Temporal SSAO velocity")).toBe(enabled);
    });
    it.each([false, true])("retains AO implementation only when imported (%s)", async (enabled) => {
        const result = await build({
            stdin: {
                contents: `import { ${enabled ? "createSsaoTask" : "createEngine"} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))};
globalThis.usedExport=${enabled ? "createSsaoTask" : "createEngine"};`,
                resolveDir: process.cwd(),
                loader: "ts",
            },
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            packages: "external",
            external: ["*?worker&inline"],
            loader: { ".wgsl": "text", ".wasm": "file" },
            outdir: ".ao-reference-cache/bundle-check",
            logLevel: "silent",
            minify: true,
            splitting: false,
            target: "esnext",
        });
        const code = result.outputFiles[0]!.text;
        expect(code.includes("ssao-unused-normal")).toBe(enabled);
        expect(code.includes("SSAO radius must be positive")).toBe(enabled);
        expect(code.includes("Upstream Filament")).toBe(false);
        expect(code.includes("vbPointDepth")).toBe(false);
        expect(code.includes("ssao-bottom-up-depth")).toBe(false);
        expect(code.includes("Unsupported SSAO algorithm")).toBe(false);
    });
    it.each([false, true])("retains the PBR lighting enabler only when requested (%s)", async (enabled) => {
        const name = enabled ? "enablePbrSsao" : "createPbrMaterial";
        const result = await build({
            stdin: {
                contents: `import { ${name} } from ${JSON.stringify(resolve("packages/babylon-lite/src/index.ts"))}; globalThis.usedExport=${name};`,
                resolveDir: process.cwd(),
                loader: "ts",
            },
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            packages: "external",
            external: ["*?worker&inline"],
            loader: { ".wgsl": "text", ".wasm": "file" },
            outdir: ".ao-reference-cache/bundle-check",
            logLevel: "silent",
            minify: true,
            splitting: false,
            target: "esnext",
        });
        const code = result.outputFiles[0]!.text;
        expect(code.includes("ssaoDiffuseVisibility")).toBe(enabled);
        expect(code.includes("Dynamic material binding must be updated before drawing")).toBe(enabled);
        expect(code.includes("PBR SSAO and its consuming pass")).toBe(enabled);
        expect(code).not.toContain("PBR SSAO cannot be sampled by a pass using a different camera");
    });
});
