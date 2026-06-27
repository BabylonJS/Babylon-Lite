/// <reference types="node" />
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-gl");
const DIST = resolve(PACKAGE_DIR, "dist");

// Invoke binaries directly via the current node executable so the test does
// not depend on PATH (which may not contain pnpm/npx in every runner).
const NODE = process.execPath;
const BUILD_SCRIPT = resolve(PACKAGE_DIR, "build.mjs");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

// The package ships a SINGLE public entry: the `@babylonjs/lite-gl` barrel (".").
// The former per-feature sub-entries (`/sprites`, `/mesh`, …) were collapsed into
// the barrel; their modules still emit as internal `dist/*.js` + `.d.ts` (the
// barrel imports them) but are NOT public `exports`.
const INTERNAL_MODULES = ["html-texture", "sprites", "render-target", "mesh", "depth-stencil", "scissor", "dynamic-texture"] as const;
const REMOVED_SUBPATHS = ["./html-texture", "./sprites", "./render-target", "./mesh", "./depth-stencil", "./scissor", "./dynamic-texture"] as const;

function typecheckDts(dts: string) {
    return spawnSync(NODE, [TSC_JS, "--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2022,dom,dom.iterable", dts], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
}

describe("babylon-lite-gl build output", () => {
    it("builds, ships a trimmed public API, and exposes the documented exports", async () => {
        // Build the package (plain `tsc` + manifest emit) to produce dist/.
        const build = spawnSync(NODE, [BUILD_SCRIPT], { cwd: PACKAGE_DIR, encoding: "utf-8" });
        if (build.status !== 0) {
            throw new Error(`babylon-lite-gl build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
        }

        // The single public entry (.js + .d.ts) plus the publish manifest must be emitted.
        for (const file of ["index.js", "index.d.ts", "package.json"]) {
            expect(existsSync(resolve(DIST, file)), `missing dist/${file}`).toBe(true);
        }

        // The emitted manifest is the scoped npm name exposing EXACTLY one public
        // export — the barrel. The former sub-entries must NOT be published anymore.
        const pkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as { name?: string; exports?: Record<string, unknown> };
        expect(pkg.name).toBe("@babylonjs/lite-gl");
        expect(Object.keys(pkg.exports ?? {})).toEqual(["."]);
        for (const subpath of REMOVED_SUBPATHS) {
            expect(pkg.exports?.[subpath], `exports["${subpath}"] must no longer be published`).toBeUndefined();
        }

        // tsc's `stripInternal` must drop every `@internal` (underscored) member
        // from the declarations — no internal surface may leak to consumers. tsc
        // ships one .d.ts per module (not a single rolled-up file), so scan EVERY
        // emitted declaration (recursively, in case src/ grows subdirectories), not
        // just the entry points: a leak in an internal or transitive module would
        // otherwise ship undetected.
        const allDts = readdirSync(DIST, { recursive: true }).filter((f): f is string => typeof f === "string" && f.endsWith(".d.ts"));
        expect(allDts.length, "no .d.ts files emitted to dist/").toBeGreaterThanOrEqual(INTERNAL_MODULES.length);
        for (const file of allDts) {
            const content = readFileSync(resolve(DIST, file), "utf-8");
            // Underscore-prefixed member declarations (optionally behind a modifier
            // like `readonly`/`static`) are `@internal` by convention and must not ship.
            const memberLeak = content.match(/^\s+(?:(?:readonly|static|abstract|declare|public|protected|private|get|set)\s+)*_[A-Za-z]\w*\s*[?:(<]/m);
            expect(memberLeak, `internal member leaked into dist/${file}: ${memberLeak ? memberLeak[0].trim() : ""}`).toBeNull();
            // A surviving `@internal` TSDoc tag means stripInternal missed a member.
            // Match the tag form (`* @internal`) so prose mentioning the word elsewhere
            // does not false-positive.
            const internalTag = content.match(/^\s*\*\s*@internal\b/m);
            expect(internalTag, `@internal tag leaked into dist/${file}: ${internalTag ? internalTag[0].trim() : ""}`).toBeNull();
        }

        // The generated public declaration type-checks in isolation (no skipLibCheck),
        // catching any internal-only types leaking into the public surface. index.d.ts
        // transitively references the internal module declarations, so this also proves
        // the emitted declaration graph resolves on disk.
        const dtsResult = typecheckDts(resolve(DIST, "index.d.ts"));
        if (dtsResult.status !== 0) {
            throw new Error(`dist/index.d.ts has TypeScript errors:\n${dtsResult.stdout ?? ""}${dtsResult.stderr ?? ""}`);
        }
        expect(dtsResult.status).toBe(0);

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
            // dynamic textures
            "createDynamicTexture",
            "updateDynamicTexture",
            "clearDynamicTextureSource",
            // render targets (LDR core + HDR opt-in)
            "createRenderTarget",
            "createFloatRenderTarget",
            "bindRenderTarget",
            "generateRenderTargetMipMaps",
            "resizeRenderTarget",
            "readRenderTargetPixels",
            "disposeRenderTarget",
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
            // sprites + html-element textures (barrel-only now the sub-entries are gone)
            "createSpriteRenderer",
            "renderSprites",
            "setSpriteRendererTexture",
            "disposeSpriteRenderer",
            "createHtmlElementTexture",
            "updateHtmlElementTexture",
            // mesh extras
            "bindIndexBuffer",
            "unbindInstanceAttributes",
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

        // Resolve the sole public subpath (".") THROUGH the emitted exports map —
        // the contract real consumers resolve against — and confirm the barrel it
        // points to loads and exposes the API. Internal modules (sprites, mesh, …)
        // still ship as files but are intentionally NOT addressable as subpaths.
        const distPkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as {
            exports: Record<string, { import?: string; types?: string }>;
        };
        const barrel = distPkg.exports["."];
        expect(barrel?.import, `exports["."].import missing`).toBeDefined();
        expect(barrel?.types, `exports["."].types missing`).toBeDefined();
        const importTarget = resolve(DIST, barrel!.import!);
        const typesTarget = resolve(DIST, barrel!.types!);
        expect(existsSync(importTarget), `exports["."] import -> ${barrel!.import} missing on disk`).toBe(true);
        expect(existsSync(typesTarget), `exports["."] types -> ${barrel!.types} missing on disk`).toBe(true);
        const resolved = (await import(pathToFileURL(importTarget).href)) as Record<string, unknown>;
        expect(typeof resolved.createGLEngine, `exports["."] should expose createGLEngine`).toBe("function");
    }, 300_000);
});
