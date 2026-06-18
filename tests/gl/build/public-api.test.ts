/// <reference types="node" />
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-gl");
const DIST = resolve(PACKAGE_DIR, "dist");

// Invoke binaries directly via the current node executable so the test does
// not depend on PATH (which may not contain pnpm/npx in every runner).
const NODE = process.execPath;
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

// Every public entry-point of the converged package. The barrel (".") plus seven
// tree-shakeable sub-entries. Each ships a `.js` + `.d.ts` and is wired through
// the emitted dist/package.json `exports` map.
const ENTRIES = ["index", "html-texture", "sprites", "render-target", "mesh", "depth-stencil", "scissor", "dynamic-texture"] as const;
const SUBPATHS = [".", "./html-texture", "./sprites", "./render-target", "./mesh", "./depth-stencil", "./scissor", "./dynamic-texture"] as const;

function typecheckDts(dts: string) {
    return spawnSync(NODE, [TSC_JS, "--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2022,dom,dom.iterable", dts], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
}

describe("babylon-lite-gl build output", () => {
    it("builds, ships a trimmed public API, and exposes the documented exports", async () => {
        // Build the package to produce dist/.
        const build = spawnSync(NODE, [VITE_JS, "build"], { cwd: PACKAGE_DIR, encoding: "utf-8" });
        if (build.status !== 0) {
            throw new Error(`babylon-lite-gl build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
        }

        // Every public entry (.js + .d.ts) plus the publish manifest must be emitted.
        const expectedFiles = [...ENTRIES.flatMap((e) => [`${e}.js`, `${e}.d.ts`]), "package.json"];
        for (const file of expectedFiles) {
            expect(existsSync(resolve(DIST, file)), `missing dist/${file}`).toBe(true);
        }

        // The emitted manifest is the scoped npm name with every subpath export.
        const pkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as { name?: string; exports?: Record<string, unknown> };
        expect(pkg.name).toBe("@babylonjs/lite-gl");
        for (const subpath of SUBPATHS) {
            expect(pkg.exports?.[subpath], `exports["${subpath}"] missing from dist manifest`).toBeDefined();
        }

        // The @internal trim pass must strip every underscored member from the
        // public declarations — no internal surface may leak to consumers.
        for (const entry of ENTRIES) {
            const content = readFileSync(resolve(DIST, `${entry}.d.ts`), "utf-8");
            const leak = content.match(/^\s+_[A-Za-z]\w*[?:(]/m);
            expect(leak, `internal member leaked into dist/${entry}.d.ts: ${leak ? leak[0] : ""}`).toBeNull();
        }

        // The generated declarations type-check in isolation (no skipLibCheck),
        // catching any internal-only types leaking into the public surface.
        for (const entry of ENTRIES) {
            const result = typecheckDts(resolve(DIST, `${entry}.d.ts`));
            if (result.status !== 0) {
                throw new Error(`dist/${entry}.d.ts has TypeScript errors:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
            }
            expect(result.status).toBe(0);
        }

        // ── The barrel exposes the full converged runtime surface ───────────
        const mod = (await import(pathToFileURL(resolve(DIST, "index.js")).href)) as Record<string, unknown>;
        for (const name of [
            // engine / context / loop
            "createGLEngine",
            "disposeGLEngine",
            "resizeGLEngine",
            "setGLEngineSize",
            "wipeGLStateCache",
            "runRenderLoop",
            "stopRenderLoop",
            // effects
            "createEffect",
            "createEffectWrapper",
            "applyEffectWrapper",
            "drawEffect",
            "setEffectTexture",
            "setEffectMatrix",
            "setEffectMatrix3x3",
            // textures (LDR core + HDR opt-in + extensions)
            "createRawTexture",
            "createFloatTexture",
            "generateTextureMipMaps",
            "loadTexture2D",
            "updateRawTexture",
            "updateTextureSamplingMode",
            "updateTextureWrapMode",
            "createTextureFromHandle",
            // dynamic textures (also a sub-entry)
            "createDynamicTexture",
            "updateDynamicTexture",
            "clearDynamicTextureSource",
            // render targets (LDR core + HDR opt-in + ping-pong)
            "createRenderTarget",
            "createFloatRenderTarget",
            "bindRenderTarget",
            "generateRenderTargetMipMaps",
            "resizeRenderTarget",
            "readRenderTargetPixels",
            "disposeRenderTarget",
            "createPingPong",
            "resizePingPong",
            "disposePingPong",
            // meshes / buffers / instancing
            "createVertexBuffer",
            "updateVertexBuffer",
            "createIndexBuffer",
            "disposeBuffer",
            "bindAttributes",
            "drawIndexed",
            "createMeshVao",
            "bindMeshVao",
            "drawMesh",
            "disposeMeshVao",
            // blend / depth-stencil / scissor
            "setBlendMode",
            "setBlendState",
            "disableBlend",
            "setDepthState",
            "setCullState",
            "setStencilState",
            "setColorMask",
            "clearEngine",
            "generateRenderTargetStencil",
            "setScissor",
            "disableScissor",
        ]) {
            expect(typeof mod[name], `barrel export ${name}`).toBe("function");
        }
        // The blend-mode / blend-equation / sampling-mode preset tables are value exports.
        expect(typeof mod.GLBlendMode, "export GLBlendMode").toBe("object");
        expect(typeof mod.GLBlendEquation, "export GLBlendEquation").toBe("object");
        expect(typeof mod.GLSamplingMode, "export GLSamplingMode").toBe("object");

        // The legacy `unbindRenderTarget` was folded into `bindRenderTarget(engine, null)`
        // and MUST NOT ship — its presence would mean the converge regressed.
        expect(mod.unbindRenderTarget, "unbindRenderTarget must not be exported").toBeUndefined();

        // ── /html-texture sub-entry ─────────────────────────────────────────
        const htmlTex = (await import(pathToFileURL(resolve(DIST, "html-texture.js")).href)) as Record<string, unknown>;
        for (const name of ["createHtmlElementTexture", "updateHtmlElementTexture"]) {
            expect(typeof htmlTex[name], `html-texture export ${name}`).toBe("function");
        }
        expect(typeof htmlTex.GLSamplingMode, "html-texture export GLSamplingMode").toBe("object");

        // ── /sprites sub-entry ──────────────────────────────────────────────
        const sprites = (await import(pathToFileURL(resolve(DIST, "sprites.js")).href)) as Record<string, unknown>;
        for (const name of ["createSpriteRenderer", "renderSprites", "setSpriteRendererTexture", "disposeSpriteRenderer"]) {
            expect(typeof sprites[name], `sprites export ${name}`).toBe("function");
        }

        // ── /render-target sub-entry (FBO + float + ping-pong) ──────────────
        const renderTarget = (await import(pathToFileURL(resolve(DIST, "render-target.js")).href)) as Record<string, unknown>;
        for (const name of [
            "createRenderTarget",
            "createFloatRenderTarget",
            "bindRenderTarget",
            "generateRenderTargetMipMaps",
            "resizeRenderTarget",
            "readRenderTargetPixels",
            "disposeRenderTarget",
            "createPingPong",
            "resizePingPong",
            "disposePingPong",
        ]) {
            expect(typeof renderTarget[name], `render-target export ${name}`).toBe("function");
        }
        expect(renderTarget.unbindRenderTarget, "render-target must not export unbindRenderTarget").toBeUndefined();

        // ── /mesh sub-entry ─────────────────────────────────────────────────
        const mesh = (await import(pathToFileURL(resolve(DIST, "mesh.js")).href)) as Record<string, unknown>;
        for (const name of [
            "createVertexBuffer",
            "updateVertexBuffer",
            "createIndexBuffer",
            "disposeBuffer",
            "bindIndexBuffer",
            "bindAttributes",
            "unbindInstanceAttributes",
            "drawIndexed",
            "createMeshVao",
            "bindMeshVao",
            "drawMesh",
            "disposeMeshVao",
        ]) {
            expect(typeof mesh[name], `mesh export ${name}`).toBe("function");
        }

        // ── /depth-stencil sub-entry ────────────────────────────────────────
        const depthStencil = (await import(pathToFileURL(resolve(DIST, "depth-stencil.js")).href)) as Record<string, unknown>;
        for (const name of ["setDepthState", "setCullState", "setStencilState", "setColorMask", "clearEngine", "generateRenderTargetStencil"]) {
            expect(typeof depthStencil[name], `depth-stencil export ${name}`).toBe("function");
        }

        // ── /scissor sub-entry ──────────────────────────────────────────────
        const scissor = (await import(pathToFileURL(resolve(DIST, "scissor.js")).href)) as Record<string, unknown>;
        for (const name of ["setScissor", "disableScissor"]) {
            expect(typeof scissor[name], `scissor export ${name}`).toBe("function");
        }

        // ── /dynamic-texture sub-entry ──────────────────────────────────────
        const dynamicTexture = (await import(pathToFileURL(resolve(DIST, "dynamic-texture.js")).href)) as Record<string, unknown>;
        for (const name of ["createDynamicTexture", "updateDynamicTexture", "clearDynamicTextureSource"]) {
            expect(typeof dynamicTexture[name], `dynamic-texture export ${name}`).toBe("function");
        }

        // Resolve each public subpath THROUGH the emitted exports map (not a
        // hard-coded dist/*.js path) — this is the contract real consumers resolve
        // against, so a broken/renamed exports target or missing types file is
        // caught here even though the direct-import checks above pass.
        const distPkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as {
            exports: Record<string, { import?: string; types?: string }>;
        };
        const subpathProbes: Array<{ subpath: string; expected: string }> = [
            { subpath: ".", expected: "createGLEngine" },
            { subpath: "./html-texture", expected: "createHtmlElementTexture" },
            { subpath: "./sprites", expected: "createSpriteRenderer" },
            { subpath: "./render-target", expected: "createRenderTarget" },
            { subpath: "./mesh", expected: "createVertexBuffer" },
            { subpath: "./depth-stencil", expected: "clearEngine" },
            { subpath: "./scissor", expected: "setScissor" },
            { subpath: "./dynamic-texture", expected: "createDynamicTexture" },
        ];
        for (const { subpath, expected } of subpathProbes) {
            const entry = distPkg.exports[subpath];
            expect(entry?.import, `exports["${subpath}"].import missing`).toBeDefined();
            expect(entry?.types, `exports["${subpath}"].types missing`).toBeDefined();
            const importTarget = resolve(DIST, entry!.import!);
            const typesTarget = resolve(DIST, entry!.types!);
            expect(existsSync(importTarget), `exports["${subpath}"] import -> ${entry!.import} missing on disk`).toBe(true);
            expect(existsSync(typesTarget), `exports["${subpath}"] types -> ${entry!.types} missing on disk`).toBe(true);
            const resolved = (await import(pathToFileURL(importTarget).href)) as Record<string, unknown>;
            expect(typeof resolved[expected], `exports["${subpath}"] should expose ${expected}`).toBe("function");
        }
    }, 300_000);
});
