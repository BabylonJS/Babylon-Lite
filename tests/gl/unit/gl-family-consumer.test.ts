// Shared rendering code written once against the backend-neutral contract and
// composed with each backend's exported functions, without casts.

import { describe, expect, it } from "vitest";
import type { GLFamily, GLKit, GLRenderTargetOf } from "../../../packages/babylon-lite-gl/src/family";
import * as Web from "../../../packages/babylon-lite-gl/src/index";
import * as Native from "../../../packages/babylon-lite-gl/src/native/index";
import { createMockCanvas, createMockGL } from "./_lite-gl-mock";

type QuadOps =
    | "createEffect"
    | "isEffectReady"
    | "createVertexBuffer"
    | "createIndexBuffer"
    | "createMeshVao"
    | "createRenderTarget"
    | "bindRenderTarget"
    | "restoreDefaultFramebuffer"
    | "setViewport"
    | "clearEngine"
    | "setBlendMode"
    | "useEffect"
    | "setEffectTexture"
    | "bindMeshVao"
    | "drawMesh";
/** Shared code names its kit through its own alias, while composition roots type theirs as `GLKit`. */
type QuadKit<F extends GLFamily> = GLKit<F, QuadOps>;

const QUAD_EFFECT = { name: "quad", vertexSource: "v", fragmentSource: "f", uniformNames: [], samplerNames: ["source"], attributeNames: ["position"] };

/** Backend-neutral consumer: renders into an offscreen target, then samples it in a quad on the default output. */
function drawQuadThroughTarget<F extends GLFamily>(kit: QuadKit<F>, engine: F["engine"], blend: F["blendMode"]): GLRenderTargetOf<F> {
    const effect = kit.createEffect(engine, QUAD_EFFECT);
    kit.isEffectReady(effect);
    const buffer = kit.createVertexBuffer(engine, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]));
    const indices = kit.createIndexBuffer(engine, new Uint16Array([0, 1, 2, 0, 2, 3]));
    const mesh = kit.createMeshVao(engine, [{ buffer, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, effect);
    const target = kit.createRenderTarget(engine, 4, 4);

    kit.bindRenderTarget(target);
    kit.clearEngine(engine, { color: { r: 0, g: 0, b: 0 } });
    kit.restoreDefaultFramebuffer(engine);
    kit.setViewport(engine);
    kit.setBlendMode(engine, blend);
    kit.useEffect(effect);
    kit.setEffectTexture(effect, "source", target.texture);
    kit.bindMeshVao(mesh);
    kit.drawMesh(mesh, 0, 0, 6);
    return target;
}

/** Backend-neutral code chooses among the blend presets every backend supports. */
function applyPortableBlendModes<F extends GLFamily>(kit: GLKit<F, "setBlendMode">, engine: F["engine"], alpha: boolean): void {
    kit.setBlendMode(engine, alpha ? 2 : 0);
    kit.setBlendMode(engine, 1);
    kit.setBlendMode(engine, 7);
}

/** Backend-neutral code cannot write a value that some backend rejects. */
function rejectNonPortableValues<F extends GLFamily>(
    kit: QuadKit<F>,
    engine: F["engine"],
    effect: F["effect"],
    buffer: F["vertexBuffer"],
    indices: F["indexBuffer"],
    mesh: F["meshVao"],
    target: GLRenderTargetOf<F>
): void {
    // @ts-expect-error Native samplers cannot be unbound.
    kit.setEffectTexture(effect, "source", null);
    // @ts-expect-error Native draws are non-instanced.
    kit.drawMesh(mesh, 5);
    // @ts-expect-error Native vertex buffers take only their data.
    kit.createVertexBuffer(engine, new Float32Array(2), true);
    // @ts-expect-error Native attributes are named and per-vertex.
    kit.createMeshVao(engine, [{ buffer, attributes: [{ size: 2 }] }], indices, effect);
    // @ts-expect-error Resources come from backend operations, not literals.
    kit.bindRenderTarget({ width: 4, height: 4, texture: target.texture });
    // @ts-expect-error No backend has blend preset 3.
    kit.setBlendMode(engine, 3);
}

/** The native composition root type-checks against the same consumer; running it requires the Babylon Native runtime. */
function composeNative(engine: Native.GLEngineContext): Native.GLRenderTarget {
    const kit: GLKit<Native.NativeGLFamily, QuadOps> = {
        createEffect: Native.createEffect,
        isEffectReady: Native.isEffectReady,
        createVertexBuffer: Native.createVertexBuffer,
        createIndexBuffer: Native.createIndexBuffer,
        createMeshVao: Native.createMeshVao,
        createRenderTarget: Native.createRenderTarget,
        bindRenderTarget: Native.bindRenderTarget,
        restoreDefaultFramebuffer: Native.restoreDefaultFramebuffer,
        setViewport: Native.setViewport,
        clearEngine: Native.clearEngine,
        setBlendMode: Native.setBlendMode,
        useEffect: Native.useEffect,
        setEffectTexture: Native.setEffectTexture,
        bindMeshVao: Native.bindMeshVao,
        drawMesh: Native.drawMesh,
    };
    // @ts-expect-error A native kit cannot drive a web engine.
    drawQuadThroughTarget(kit, {} as Web.GLEngineContext, 7);
    // @ts-expect-error Blend preset 3 is outside the native blend modes.
    drawQuadThroughTarget(kit, engine, 3);
    return drawQuadThroughTarget(kit, engine, 7);
}

describe("lite-gl backend family consumer", () => {
    it("drives a web engine through a selective kit without casts", () => {
        const mock = createMockGL();
        const engine = Web.createGLEngine(createMockCanvas(mock));
        const kit: GLKit<Web.WebGLFamily, QuadOps> = {
            createEffect: Web.createEffect,
            isEffectReady: Web.isEffectReady,
            createVertexBuffer: Web.createVertexBuffer,
            createIndexBuffer: Web.createIndexBuffer,
            createMeshVao: Web.createMeshVao,
            createRenderTarget: Web.createRenderTarget,
            bindRenderTarget: Web.bindRenderTarget,
            restoreDefaultFramebuffer: Web.restoreDefaultFramebuffer,
            setViewport: Web.setViewport,
            clearEngine: Web.clearEngine,
            setBlendMode: Web.setBlendMode,
            useEffect: Web.useEffect,
            setEffectTexture: Web.setEffectTexture,
            bindMeshVao: Web.bindMeshVao,
            drawMesh: Web.drawMesh,
        };

        const target: Web.GLRenderTarget = drawQuadThroughTarget(kit, engine, Web.GLBlendMode.PREMULTIPLIED);
        applyPortableBlendModes(kit, engine, true);
        applyPortableBlendModes(kit, engine, false);

        expect(target.texture.width).toBe(4);
        expect(mock.count("drawElements")).toBe(1);
        Web.disposeGLEngine(engine);
    });

    it("composes the native backend from its exports", () => {
        expect(composeNative).toBeTypeOf("function");
    });

    it("rejects values a backend does not accept in backend-neutral code", () => {
        expect(rejectNonPortableValues).toBeTypeOf("function");
    });
});
