/// <reference types="node" />
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { build as bundle } from "esbuild";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-gl");
const DIST = resolve(PACKAGE_DIR, "dist");

// Invoke binaries directly via the current node executable so the test does
// not depend on PATH (which may not contain pnpm/npx in every runner).
const NODE = process.execPath;
const BUILD_SCRIPT = resolve(PACKAGE_DIR, "build.mjs");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

// The package ships three public entries: the WebGL2 barrel ("."), the Babylon
// Native backend ("./native") and the browser-free backend contract ("./family").
// The former per-feature sub-entries (`/sprites`,
// `/mesh`, …) were collapsed into the barrel; their modules still emit as internal
// `dist/*.js` + `.d.ts` (the barrel imports them) but are NOT public `exports`.
const INTERNAL_MODULES = ["html-texture", "sprites", "render-target", "mesh", "depth-stencil", "scissor", "dynamic-texture", "texture-source"] as const;
const REMOVED_SUBPATHS = ["./html-texture", "./sprites", "./render-target", "./mesh", "./depth-stencil", "./scissor", "./dynamic-texture"] as const;
const BROWSER_LIB = "es2022,dom,dom.iterable";
const HOST_NEUTRAL_LIB = "es2022";

function typecheckDts(dts: string, lib: string) {
    // `--ignoreConfig` is required under TypeScript 6: passing a file on the
    // command line while a tsconfig.json exists in cwd is otherwise an error
    // (TS5112). WebGPU types are not needed here (WebGL package).
    return spawnSync(NODE, [TSC_JS, "--ignoreConfig", "--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", lib, dts], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
}

// Compiled against the emitted declarations, where internal members are removed: every
// `@ts-expect-error` must still be an error and every other line must compile.
const RESOURCE_IDENTITY_FIXTURE = `
import type { GLFamily, GLKit } from "./family.js";
import * as Web from "./index.js";
import * as Native from "./native/index.js";

declare const webEngine: Web.GLEngineContext;
declare const webEffect: Web.GLEffect;
declare const webTexture: Web.GLTexture;
declare const webTarget: Web.GLRenderTarget;
declare const webVertex: Web.GLVertexBuffer;
declare const webIndex: Web.GLIndexBuffer;
declare const webMesh: Web.GLMeshVao;
declare const engine: Native.GLEngineContext;
declare const effect: Native.GLEffect;
declare const texture: Native.GLTexture;
declare const target: Native.GLRenderTarget;
declare const vertex: Native.GLVertexBuffer;
declare const indices: Native.GLIndexBuffer;
declare const mesh: Native.GLMeshVao;
declare const textureWithBufferFields: Native.GLTexture & { readonly byteLength: number };

type FlowOps = "createRenderTarget" | "setEffectTexture" | "createVertexBuffer" | "createIndexBuffer" | "createMeshVao" | "drawMesh" | "disposeBuffer";
const nativeKit: GLKit<Native.NativeGLFamily, FlowOps> = {
    createRenderTarget: Native.createRenderTarget,
    setEffectTexture: Native.setEffectTexture,
    createVertexBuffer: Native.createVertexBuffer,
    createIndexBuffer: Native.createIndexBuffer,
    createMeshVao: Native.createMeshVao,
    drawMesh: Native.drawMesh,
    disposeBuffer: Native.disposeBuffer,
};
const webKit: GLKit<Web.WebGLFamily, FlowOps> = {
    createRenderTarget: Web.createRenderTarget,
    setEffectTexture: Web.setEffectTexture,
    createVertexBuffer: Web.createVertexBuffer,
    createIndexBuffer: Web.createIndexBuffer,
    createMeshVao: Web.createMeshVao,
    drawMesh: Web.drawMesh,
    disposeBuffer: Web.disposeBuffer,
};

// Correlated resources flow through generic code and both backends.
function flow<F extends GLFamily>(kit: GLKit<F, FlowOps>, engine: F["engine"], effect: F["effect"]): void {
    kit.setEffectTexture(effect, "source", kit.createRenderTarget(engine, 4, 4).texture);
    const buffer = kit.createVertexBuffer(engine, new Float32Array(8));
    const indices = kit.createIndexBuffer(engine, new Uint16Array(6));
    kit.drawMesh(kit.createMeshVao(engine, [{ buffer, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, effect));
    kit.disposeBuffer(buffer);
    kit.disposeBuffer(indices);
}
flow(nativeKit, engine, effect);
flow(webKit, webEngine, webEffect);
Native.setEffectTexture(effect, "source", target.texture);
Native.drawMesh(mesh, 0, 3);

// Web resources are not native resources.
// @ts-expect-error web engine
Native.createRenderTarget(webEngine, 4, 4);
// @ts-expect-error web engine through a native kit
nativeKit.createRenderTarget(webEngine, 4, 4);
// @ts-expect-error web effect
Native.useEffect(webEffect);
// @ts-expect-error web texture
Native.setEffectTexture(effect, "source", webTexture);
// @ts-expect-error web texture through a native kit
nativeKit.setEffectTexture(effect, "source", webTexture);
// @ts-expect-error web render target
Native.bindRenderTarget(webTarget);
// @ts-expect-error web vertex buffer
Native.createMeshVao(engine, [{ buffer: webVertex, attributes: [] }], indices, effect);
// @ts-expect-error web index buffer
Native.createMeshVao(engine, [], webIndex, effect);
// @ts-expect-error web mesh
Native.drawMesh(webMesh);
// @ts-expect-error web engine into a generic flow over the native family
flow(nativeKit, webEngine, effect);

// Native resources are not web resources.
// @ts-expect-error native engine
Web.createRenderTarget(engine, 4, 4);
// @ts-expect-error native effect
Web.useEffect(effect);
// @ts-expect-error native texture
Web.setEffectTexture(webEffect, "source", texture);
// @ts-expect-error native render target
Web.bindRenderTarget(target);
// @ts-expect-error native mesh
Web.drawMesh(mesh);

// One kind of native resource is not another, nor is a structural look-alike.
// @ts-expect-error a texture is not a buffer
Native.disposeBuffer(texture);
// @ts-expect-error nor is a texture with a buffer's public fields
Native.disposeBuffer(textureWithBufferFields);
// @ts-expect-error a vertex buffer is not an index buffer
Native.createMeshVao(engine, [], vertex, effect);
// @ts-expect-error a texture is not an engine
Native.createRenderTarget(texture, 4, 4);
// @ts-expect-error a render target is not a texture
Native.setEffectTexture(effect, "source", target);
// @ts-expect-error an object with a texture's public fields is not a texture
Native.setEffectTexture(effect, "source", { width: 1, height: 1, isReady: true });
`;

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

        // The emitted manifest is the scoped npm name exposing EXACTLY the web barrel,
        // the native entry and the contract entry. The former sub-entries must NOT be published anymore.
        const pkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as { name?: string; exports?: Record<string, unknown>; dependencies?: Record<string, string> };
        expect(pkg.name).toBe("@babylonjs/lite-gl");

        // The emitted text modules import `text-shaper` by bare specifier, so the published manifest must
        // carry the source package's runtime dependencies.
        const sourceDependencies = (JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as { dependencies?: Record<string, string> }).dependencies;
        expect(sourceDependencies?.["text-shaper"]).toBeDefined();
        expect(pkg.dependencies).toEqual(sourceDependencies);
        expect(Object.keys(pkg.exports ?? {})).toEqual([".", "./native", "./family"]);
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
        const dtsResult = typecheckDts(resolve(DIST, "index.d.ts"), BROWSER_LIB);
        if (dtsResult.status !== 0) {
            throw new Error(`dist/index.d.ts has TypeScript errors:\n${dtsResult.stdout ?? ""}${dtsResult.stderr ?? ""}`);
        }
        expect(dtsResult.status).toBe(0);
        expect(readFileSync(resolve(DIST, "index.d.ts"), "utf-8")).toMatch(/export type \{[^}]*\bGLStencilOpState\b[^}]*\} from "\.\/depth-stencil\.js";/);
        expect(readFileSync(resolve(DIST, "index.d.ts"), "utf-8")).toMatch(/export type \{[^}]*\bGLTexture3D\b[^}]*\} from "\.\/texture-3d\.js";/);
        expect(readFileSync(resolve(DIST, "index.d.ts"), "utf-8")).toMatch(/export type \{[^}]*\bGLEffectWaitOptions\b[^}]*\} from "\.\/effect-ready\.js";/);
        expect(readFileSync(resolve(DIST, "index.d.ts"), "utf-8")).toMatch(/export type \{[^}]*\bGLTextureSourceOptions\b[^}]*\} from "\.\/texture-source\.js";/);
        expect(readFileSync(resolve(DIST, "texture-source.d.ts"), "utf-8")).toContain(
            "createTextureFromSource(engine: GLEngineContext, source: TexImageSource, options?: GLTextureSourceOptions): GLTexture"
        );
        expect(readFileSync(resolve(DIST, "effect.d.ts"), "utf-8")).toContain("getEffectCompilationError(effect: GLEffect): string | null");
        expect(readFileSync(resolve(DIST, "effect.d.ts"), "utf-8")).toContain("setEffectFloatArray3(effect: GLEffect, name: string, array: Float32Array | number[]): void");
        expect(readFileSync(resolve(DIST, "mesh.d.ts"), "utf-8")).toContain("disableAttributeByIndex(engine: GLEngineContext, location: number): void");
        expect(readFileSync(resolve(DIST, "mesh.d.ts"), "utf-8")).toContain("unbindAllAttributes(engine: GLEngineContext): void");
        expect(readFileSync(resolve(DIST, "context.d.ts"), "utf-8")).toContain(
            "createHostOwnedGLEngine(canvas: HTMLCanvasElement | OffscreenCanvas, options?: GLEngineOptions): GLEngineContext"
        );
        expect(readFileSync(resolve(DIST, "mesh.d.ts"), "utf-8")).toContain(
            "bindAttributesCached(vb: GLVertexBuffer, descriptors: readonly GLAttributeDescriptor[], effect: GLEffect, computeStride?: boolean): void"
        );
        expect(readFileSync(resolve(DIST, "effect-ready.d.ts"), "utf-8")).toContain("waitForEffect(effect: GLEffect, options?: GLEffectWaitOptions): Promise<GLEffect>");
        expect(readFileSync(resolve(DIST, "framebuffer-validation.d.ts"), "utf-8")).toContain("setFramebufferValidation(engine: GLEngineContext, enabled: boolean): void");

        // ── The barrel exposes the full converged runtime surface ───────────
        const mod = (await import(pathToFileURL(resolve(DIST, "index.js")).href)) as Record<string, unknown>;
        for (const name of [
            // engine / context / loop
            "createGLEngine",
            "createHostOwnedGLEngine",
            "disposeGLEngine",
            "resizeGLEngine",
            "setGLEngineSize",
            "wipeGLStateCache",
            "setFramebufferValidation",
            "runRenderLoop",
            "stopRenderLoop",
            "beginFrame",
            "endFrame",
            "captureGPUFrameTime",
            "getGPUFrameTimeCounter",
            // effects
            "createEffect",
            "getEffectCompilationError",
            "waitForEffect",
            "createEffectWrapper",
            "applyEffectWrapper",
            "drawEffect",
            "setEffectTexture",
            "setEffectMatrix",
            "setEffectMatrix3x3",
            "setEffectFloatArray3",
            // textures (LDR core + HDR opt-in + extensions)
            "createRawTexture",
            "createTextureFromSource",
            "bindTexture",
            "unbindTexture",
            "createTexture3DFromPixels",
            "bindTexture3D",
            "unbindTexture3D",
            "setEffectTexture3D",
            "generateTexture3DMipMaps",
            "updateTexture3DSamplingMode",
            "updateTexture3DWrapMode",
            "disposeTexture3D",
            "createFloatTexture",
            "generateTextureMipMaps",
            "loadTexture2D",
            "updateRawTexture",
            "updateTextureSamplingMode",
            "updateTextureSamplingPreset",
            "updateTextureWrapMode",
            "createTextureFromHandle",
            "getSamplingModeFilters",
            "isTextureReady",
            // dynamic textures
            "createDynamicTexture",
            "updateDynamicTexture",
            "clearDynamicTextureSource",
            // render targets (LDR core + HDR opt-in)
            "createRenderTarget",
            "createFloatRenderTarget",
            "bindRenderTarget",
            "restoreDefaultFramebuffer",
            "generateRenderTargetMipMaps",
            "resizeRenderTarget",
            "readRenderTargetPixels",
            "readRenderTargetPixelsToBuffer",
            "disposeRenderTarget",
            // meshes / buffers / instancing
            "createVertexBuffer",
            "updateVertexBuffer",
            "createIndexBuffer",
            "disposeBuffer",
            "bindAttributes",
            "bindAttributesCached",
            "disableAttributeByIndex",
            "unbindAllAttributes",
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
            "setStencilOpSeparate",
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
        expect(mod.setBoundTextureParams, "internal texture parameter helper must not be public").toBeUndefined();

        // The legacy `unbindRenderTarget` was folded into `restoreDefaultFramebuffer(engine)`
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

        // ── The Babylon Native entry, resolved through the same exports map ──
        const nativeEntry = distPkg.exports["./native"];
        expect(nativeEntry).toEqual({ import: "./native/index.js", types: "./native/index.d.ts" });
        const nativeTypes = resolve(DIST, nativeEntry!.types!);
        // Native and contract consumers have no browser host, so their declarations
        // must resolve without the DOM library.
        const nativeDtsResult = typecheckDts(nativeTypes, HOST_NEUTRAL_LIB);
        if (nativeDtsResult.status !== 0) {
            throw new Error(`dist/native/index.d.ts has TypeScript errors:\n${nativeDtsResult.stdout ?? ""}${nativeDtsResult.stderr ?? ""}`);
        }

        // ── The backend contract entry: types only, browser-free ─────────────
        const familyEntry = distPkg.exports["./family"];
        expect(familyEntry).toEqual({ import: "./family.js", types: "./family.d.ts" });
        const familyDtsResult = typecheckDts(resolve(DIST, familyEntry!.types!), HOST_NEUTRAL_LIB);
        if (familyDtsResult.status !== 0) {
            throw new Error(`dist/family.d.ts has TypeScript errors:\n${familyDtsResult.stdout ?? ""}${familyDtsResult.stderr ?? ""}`);
        }
        // Backend and resource-kind identity survives the declaration trimming.
        const identityFixture = resolve(DIST, "resource-identity.check.ts");
        writeFileSync(identityFixture, RESOURCE_IDENTITY_FIXTURE);
        try {
            const identityResult = typecheckDts(identityFixture, BROWSER_LIB);
            if (identityResult.status !== 0) {
                throw new Error(`resource identity fixture failed against the emitted declarations:\n${identityResult.stdout ?? ""}${identityResult.stderr ?? ""}`);
            }
        } finally {
            rmSync(identityFixture);
        }
        const familyMod = (await import(pathToFileURL(resolve(DIST, familyEntry!.import!)).href)) as Record<string, unknown>;
        expect(Object.keys(familyMod), "the contract entry must carry no runtime exports").toEqual([]);

        // Importing the native entry must not touch the native runtime; it is only
        // required once an engine is created.
        expect((globalThis as { _native?: unknown })._native).toBeUndefined();
        const nativeMod = (await import(pathToFileURL(resolve(DIST, nativeEntry!.import!)).href)) as Record<string, unknown>;
        expect(() => (nativeMod.createNativeEngine as () => unknown)()).toThrow(/requires the Babylon Native runtime/);

        // The two entries are disjoint module graphs: a web bundle carries no native
        // code and a native bundle carries no WebGL code.
        const graph = async (entry: string) =>
            Object.keys(
                (await bundle({ entryPoints: [resolve(DIST, entry)], bundle: true, format: "esm", platform: "neutral", write: false, metafile: true, logLevel: "silent" })).metafile
                    .inputs
            ).map((input) => input.replace(/\\/g, "/"));
        const webInputs = await graph(barrel!.import!);
        const nativeInputs = await graph(nativeEntry!.import!);
        expect(webInputs.filter((input) => input.includes("/dist/native/"))).toEqual([]);
        expect(nativeInputs.length).toBeGreaterThan(1);
        expect(nativeInputs.filter((input) => !input.includes("/dist/native/"))).toEqual([]);
    }, 300_000);
});
