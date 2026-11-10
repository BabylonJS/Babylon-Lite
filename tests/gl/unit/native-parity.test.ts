/// <reference types="node" />
/**
 * Parity guard: the Babylon Native barrel (`src/index.native.ts`) must export
 * every value AND type name of the WebGL barrel (`src/index.ts`), and each shared
 * function must keep the WebGL call signature (same parameter names, order,
 * optional-ness, and mutually assignable types). Backend-specific differences
 * are allowed ONLY through the commented allow-lists below.
 */
import { resolve } from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as webgl from "../../../packages/babylon-lite-gl/src/index";
import * as native from "../../../packages/babylon-lite-gl/src/index.native";

const SRC = resolve(__dirname, "../../../packages/babylon-lite-gl/src");
const WEBGL_BARREL = resolve(SRC, "index.ts");
const NATIVE_BARREL = resolve(SRC, "index.native.ts");

/** Native-only VALUE exports (explicit native factory/disposer). */
const NATIVE_ONLY_VALUES = ["createNativeGLEngine", "disposeNativeGLEngine"];
/** Native-only TYPE exports (host sources accepted by the texture-source APIs). */
const NATIVE_ONLY_TYPES = ["NativeCanvasSource", "NativePixelSource", "NativeTextureSource"];

/**
 * Types whose SHAPE is inherently backend-specific: they carry the GPU handle
 * type (`WebGLTexture` vs native `Uint32Array` handles), the context object
 * (`WebGL2RenderingContext` vs `_native.Engine`) or WebGL-only capability
 * fields. They must exist under the same name; a function parameter / return
 * typed with one of them is compared BY NAME instead of by assignability.
 */
const BACKEND_TYPES = new Set([
    "GLEngineContext", // WebGL2 context + canvas vs the `_native.Engine` + command encoder.
    "GLEngineCaps", // WebGL extension caps vs native capability flags (texture3D, separateStencil, ...).
    "GLEngineOptions", // WebGL context-attribute options vs native engine options.
    "GLEffect", // WebGLProgram / WebGLUniformLocation vs native program + uniform handles.
    "GLEffectWrapper", // Holds a backend GLEffect.
    "GLTexture", // WebGLTexture vs native texture handle.
    "GLTexture3D", // WebGLTexture vs native handle (3D textures are a declared divergence).
    "GLRenderTarget", // WebGLFramebuffer/renderbuffers vs native framebuffer handle.
    "GLRenderTargetOptions", // `colorTexture` is a backend GLTexture.
    "GLFloatRenderTargetOptions", // Derived from GLRenderTargetOptions.
    "GLVertexBuffer", // WebGLBuffer vs native vertex-buffer handle.
    "GLIndexBuffer", // WebGLBuffer vs native index-buffer handle.
    "GLMeshVao", // WebGLVertexArrayObject vs native VAO handle.
    "GLMeshVertexBuffer", // Holds a backend GLVertexBuffer.
    "GLSpriteRenderer", // Holds backend buffers/effect.
    "GLSpriteRendererOptions", // `texture` is a backend GLTexture.
]);

/**
 * Functions whose signature intentionally differs beyond BACKEND_TYPES. Each
 * entry must still have the same parameter names/count and optional-ness; only
 * the listed parameter's type (`param`) or the return type (`returns`) may differ.
 */
const SIGNATURE_ALLOW_LIST: Record<string, { param?: string; returns?: true; reason: string }> = {
    createGLEngine: { param: "canvas", reason: "Native has no canvas; also accepts null (the argument is ignored)." },
    createTextureFromHandle: { param: "handle", reason: "Wraps a native texture handle instead of a WebGLTexture." },
    createHtmlElementTexture: { param: "element", reason: "Also accepts Native*Source; DOM elements throw on Native." },
    updateDynamicTexture: { param: "source", reason: "Also accepts Native*Source; DOM sources throw on Native." },
    createTextureFromSource: { param: "source", reason: "Also accepts Native*Source; DOM sources throw on Native." },
    // Babylon Native's `readTexture` is promise-based (GPU→CPU blit completes on a later frame),
    // so readback cannot be synchronous; the async result is the same buffer WebGL returns.
    readRenderTargetPixels: { returns: true, reason: "Returns Promise<ArrayBufferView>: the native readTexture is asynchronous." },
    readRenderTargetPixelsToBuffer: { returns: true, reason: "Returns Promise<void>: the native readTexture is asynchronous." },
};

interface BarrelInfo {
    checker: ts.TypeChecker;
    exports: Map<string, ts.Symbol>;
}

let cached: { program: ts.Program; webgl: BarrelInfo; native: BarrelInfo } | undefined;

function load(): { program: ts.Program; webgl: BarrelInfo; native: BarrelInfo } {
    if (cached) {
        return cached;
    }
    const program = ts.createProgram([WEBGL_BARREL, NATIVE_BARREL], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
    });
    const checker = program.getTypeChecker();
    const info = (file: string): BarrelInfo => {
        const sf = program.getSourceFile(file)!;
        const mod = checker.getSymbolAtLocation(sf)!;
        const exports = new Map<string, ts.Symbol>();
        for (const sym of checker.getExportsOfModule(mod)) {
            exports.set(sym.getName(), sym);
        }
        return { checker, exports };
    };
    cached = { program, webgl: info(WEBGL_BARREL), native: info(NATIVE_BARREL) };
    return cached;
}

function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
    return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

/** Printed (alias-preserving) name of a type, without `import("…")` qualifiers. */
function typeName(checker: ts.TypeChecker, type: ts.Type): string {
    return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
}

/** Names of BACKEND_TYPES referenced by a printed type string. */
function backendTypesIn(printed: string): string[] {
    return (printed.match(/\b[A-Za-z0-9_]+\b/g) ?? []).filter((n) => BACKEND_TYPES.has(n));
}

/** Compare two parameter / return types: mutually assignable, or identical
 *  printed text where every differing reference is a BACKEND_TYPES name. */
function compatible(checker: ts.TypeChecker, a: ts.Type, b: ts.Type): boolean {
    if (checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a)) {
        return true;
    }
    const pa = typeName(checker, a);
    const pb = typeName(checker, b);
    return pa === pb && backendTypesIn(pa).length > 0;
}

function signatureMismatches(name: string): string[] {
    const { webgl: w, native: n } = load();
    const checker = w.checker;
    const ws = resolveAlias(checker, w.exports.get(name)!);
    const ns = resolveAlias(checker, n.exports.get(name)!);
    const wSigs = checker.getTypeOfSymbol(ws).getCallSignatures();
    const nSigs = checker.getTypeOfSymbol(ns).getCallSignatures();
    if (wSigs.length !== 1 || nSigs.length !== 1) {
        return [`${name}: expected one call signature each (webgl ${wSigs.length}, native ${nSigs.length})`];
    }
    const wSig = wSigs[0]!;
    const nSig = nSigs[0]!;
    const problems: string[] = [];
    const wParams = wSig.getParameters();
    const nParams = nSig.getParameters();
    if (wParams.length !== nParams.length) {
        return [`${name}: parameter count ${nParams.length} != WebGL ${wParams.length}`];
    }
    const allowed = SIGNATURE_ALLOW_LIST[name];
    for (let i = 0; i < wParams.length; i++) {
        const wp = wParams[i]!;
        const np = nParams[i]!;
        if (wp.getName() !== np.getName()) {
            problems.push(`${name}: parameter ${i} named "${np.getName()}" != WebGL "${wp.getName()}"`);
            continue;
        }
        const wDecl = wp.valueDeclaration as ts.ParameterDeclaration;
        const nDecl = np.valueDeclaration as ts.ParameterDeclaration;
        const wOpt = checker.isOptionalParameter(wDecl);
        const nOpt = checker.isOptionalParameter(nDecl);
        if (wOpt !== nOpt) {
            problems.push(`${name}(${wp.getName()}): optional ${nOpt} != WebGL ${wOpt}`);
        }
        if (allowed?.param === wp.getName()) {
            continue;
        }
        const wt = checker.getTypeOfSymbolAtLocation(wp, wDecl);
        const nt = checker.getTypeOfSymbolAtLocation(np, nDecl);
        if (!compatible(checker, wt, nt)) {
            problems.push(`${name}(${wp.getName()}): native "${typeName(checker, nt)}" vs WebGL "${typeName(checker, wt)}"`);
        }
    }
    const wr = wSig.getReturnType();
    const nr = nSig.getReturnType();
    if (!allowed?.returns && !compatible(checker, wr, nr)) {
        problems.push(`${name}: returns native "${typeName(checker, nr)}" vs WebGL "${typeName(checker, wr)}"`);
    }
    return problems;
}

describe("native barrel parity with the WebGL barrel", () => {
    it("exports exactly the WebGL runtime value names (plus the allow-listed native extras)", () => {
        const webglNames = Object.keys(webgl).sort();
        const nativeNames = Object.keys(native)
            .filter((n) => !NATIVE_ONLY_VALUES.includes(n))
            .sort();
        expect(nativeNames).toEqual(webglNames);
        for (const extra of NATIVE_ONLY_VALUES) {
            expect(typeof (native as Record<string, unknown>)[extra]).toBe("function");
        }
        for (const name of webglNames) {
            expect(typeof (native as Record<string, unknown>)[name], name).toBe(typeof (webgl as Record<string, unknown>)[name]);
        }
    });

    it("exports exactly the WebGL type + value names at the type level (plus the allow-listed native extras)", () => {
        const { webgl: w, native: n } = load();
        const webglNames = [...w.exports.keys()].sort();
        const nativeNames = [...n.exports.keys()].filter((x) => !NATIVE_ONLY_VALUES.includes(x) && !NATIVE_ONLY_TYPES.includes(x)).sort();
        expect(nativeNames).toEqual(webglNames);
        for (const extra of NATIVE_ONLY_TYPES) {
            expect(n.exports.has(extra), extra).toBe(true);
        }
    });

    it("type-checks both barrels without errors", () => {
        const { program } = load();
        const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        expect(diagnostics).toEqual([]);
    });

    it("keeps every shared function's signature (names, order, optional-ness, mutually assignable types)", () => {
        const { webgl: w } = load();
        const checker = w.checker;
        const problems: string[] = [];
        let checked = 0;
        for (const [name, sym] of w.exports) {
            const target = resolveAlias(checker, sym);
            if (!(target.flags & ts.SymbolFlags.Function)) {
                continue;
            }
            checked++;
            problems.push(...signatureMismatches(name));
        }
        expect(checked).toBeGreaterThan(120);
        expect(problems).toEqual([]);
    });

    it("keeps every non-backend exported type mutually assignable with the WebGL one", () => {
        const { webgl: w, native: n } = load();
        const checker = w.checker;
        const problems: string[] = [];
        let checked = 0;
        for (const [name, sym] of w.exports) {
            const ws = resolveAlias(checker, sym);
            if (!(ws.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) || BACKEND_TYPES.has(name)) {
                continue;
            }
            checked++;
            const ns = resolveAlias(checker, n.exports.get(name)!);
            const wt = checker.getDeclaredTypeOfSymbol(ws);
            const nt = checker.getDeclaredTypeOfSymbol(ns);
            if (!compatible(checker, wt, nt)) {
                problems.push(`${name}: native "${typeName(checker, nt)}" is not mutually assignable with WebGL "${typeName(checker, wt)}"`);
            }
        }
        expect(checked).toBeGreaterThan(40);
        expect(problems).toEqual([]);
    });

    it("documents a reason for every signature allow-list entry, and each entry is still needed", () => {
        for (const [name, entry] of Object.entries(SIGNATURE_ALLOW_LIST)) {
            expect(entry.reason.length, name).toBeGreaterThan(10);
            const saved = SIGNATURE_ALLOW_LIST[name];
            delete SIGNATURE_ALLOW_LIST[name];
            try {
                expect(signatureMismatches(name).length, `${name} no longer needs its allow-list entry`).toBeGreaterThan(0);
            } finally {
                SIGNATURE_ALLOW_LIST[name] = saved!;
            }
        }
    });
});
