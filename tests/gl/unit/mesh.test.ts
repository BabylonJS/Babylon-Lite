import { describe, expect, it } from "vitest";
import { createGLEngine, disposeGLEngine } from "../../../packages/babylon-lite-gl/src/context";
import { createEffect, isEffectReady, useEffect } from "../../../packages/babylon-lite-gl/src/effect";
import {
    createVertexBuffer,
    updateVertexBuffer,
    createIndexBuffer,
    disposeBuffer,
    bindIndexBuffer,
    bindAttributes,
    unbindInstanceAttributes,
    drawIndexed,
    createMeshVao,
    drawMesh,
    disposeMeshVao,
    type GLAttributeDescriptor,
} from "../../../packages/babylon-lite-gl/src/mesh";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

function makeReadyEffect(engine: ReturnType<typeof makeEngine>["engine"]) {
    const eff = createEffect(engine, {
        name: "mesh-test",
        vertexSource: "v",
        fragmentSource: "f",
        uniformNames: [],
        samplerNames: [],
        attributeNames: ["a"],
    });
    isEffectReady(engine, eff);
    return eff;
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl mesh: buffer creation", () => {
    it("createVertexBuffer uploads STATIC_DRAW by default and registers for restore", () => {
        const { mock, engine } = makeEngine();
        const data = new Float32Array([0, 0, 1, 0, 1, 1]);
        const vb = createVertexBuffer(engine, data);
        expect(vb.byteLength).toBe(data.byteLength);
        const bd = callsNamed(mock, "bufferData");
        expect(bd).toHaveLength(1);
        expect(bd[0]?.args[0]).toBe(engine.gl.ARRAY_BUFFER);
        expect(bd[0]?.args[2]).toBe(engine.gl.STATIC_DRAW);
        expect(engine._buffers).toHaveLength(1);
    });

    it("createVertexBuffer(dynamic) uses DYNAMIC_DRAW", () => {
        const { mock, engine } = makeEngine();
        createVertexBuffer(engine, new Float32Array([1, 2]), true);
        expect(callsNamed(mock, "bufferData")[0]?.args[2]).toBe(engine.gl.DYNAMIC_DRAW);
    });

    it("createIndexBuffer with Uint16Array is 16-bit; Uint32Array is 32-bit", () => {
        const { engine } = makeEngine();
        const ib16 = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const ib32 = createIndexBuffer(engine, new Uint32Array([0, 1, 2, 3]));
        expect(ib16.is32Bits).toBe(false);
        expect(ib16.count).toBe(3);
        expect(ib32.is32Bits).toBe(true);
        expect(ib32.count).toBe(4);
    });

    it("createIndexBuffer binds the default VAO first (never corrupts a named VAO)", () => {
        const { mock, engine } = makeEngine();
        // Simulate a named VAO being current (as after a sprite/quad draw).
        engine._state.boundVao = { __tag: "vao" } as unknown as WebGLVertexArrayObject;
        createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const bv = callsNamed(mock, "bindVertexArray");
        expect(bv.some((c) => c.args[0] === null)).toBe(true);
        expect(engine._state.boundVao).toBeNull();
    });

    it("updateVertexBuffer issues bufferSubData and refreshes retained data on full update", () => {
        const { mock, engine } = makeEngine();
        const vb = createVertexBuffer(engine, new Float32Array([0, 0]), true);
        const next = new Float32Array([5, 6]);
        updateVertexBuffer(engine, vb, next);
        const sub = callsNamed(mock, "bufferSubData");
        expect(sub).toHaveLength(1);
        expect(sub[0]?.args[1]).toBe(0);
        expect(vb._data).toBe(next);
    });
});

describe("lite-gl mesh: bindIndexBuffer cache", () => {
    it("elides a repeat bind of the same index buffer", () => {
        const { mock, engine } = makeEngine();
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        mock.clear();
        bindIndexBuffer(engine, ib);
        bindIndexBuffer(engine, ib);
        // Already bound at creation → both elided.
        expect(callsNamed(mock, "bindBuffer").filter((c) => c.args[0] === engine.gl.ELEMENT_ARRAY_BUFFER)).toHaveLength(0);
    });
});

describe("lite-gl mesh: bindAttributes (Babylon bindInstancesBuffer parity)", () => {
    it("defaults divisor to 1 (instanced) when omitted", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0, 0]));
        mock.clear();
        const descriptors: GLAttributeDescriptor[] = [{ index: 3, size: 4, offset: 0 }];
        bindAttributes(engine, vb, descriptors, eff);
        const div = callsNamed(mock, "vertexAttribDivisor");
        expect(div).toHaveLength(1);
        expect(div[0]?.args).toEqual([3, 1]);
    });

    it("honors an explicit divisor of 0 (per-vertex)", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0]));
        mock.clear();
        bindAttributes(engine, vb, [{ index: 0, size: 2, offset: 0, divisor: 0 }], eff);
        expect(callsNamed(mock, "vertexAttribDivisor")[0]?.args).toEqual([0, 0]);
    });

    it("computeStride=false → stride 0 (sliding window); offsets preserved", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array(40));
        mock.clear();
        const descriptors: GLAttributeDescriptor[] = [
            { index: 1, size: 4, offset: 0 },
            { index: 2, size: 4, offset: 16 },
            { index: 3, size: 4, offset: 32 },
        ];
        bindAttributes(engine, vb, descriptors, eff);
        const ptr = callsNamed(mock, "vertexAttribPointer");
        expect(ptr).toHaveLength(3);
        // (index, size, type, normalized, STRIDE, offset)
        expect(ptr[0]?.args).toEqual([1, 4, engine.gl.FLOAT, false, 0, 0]);
        expect(ptr[1]?.args).toEqual([2, 4, engine.gl.FLOAT, false, 0, 16]);
        expect(ptr[2]?.args).toEqual([3, 4, engine.gl.FLOAT, false, 0, 32]);
    });

    it("computeStride=true → stride = Σ(size·4)", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array(24));
        mock.clear();
        const descriptors: GLAttributeDescriptor[] = [
            { index: 1, size: 3, offset: 0 },
            { index: 2, size: 3, offset: 12 },
        ];
        bindAttributes(engine, vb, descriptors, eff, true);
        const ptr = callsNamed(mock, "vertexAttribPointer");
        expect(ptr[0]?.args[4]).toBe(24); // (3+3)*4
        expect(ptr[1]?.args[4]).toBe(24);
    });

    it("tracks touched locations so unbindInstanceAttributes resets divisor to 0", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array(16));
        bindAttributes(
            engine,
            vb,
            [
                { index: 5, size: 4, offset: 0 },
                { index: 6, size: 4, offset: 16 },
            ],
            eff
        );
        expect(engine._state.instanceLocations).toEqual([5, 6]);
        mock.clear();
        unbindInstanceAttributes(engine);
        const div = callsNamed(mock, "vertexAttribDivisor");
        expect(div.map((c) => c.args)).toEqual([
            [5, 0],
            [6, 0],
        ]);
        expect(engine._state.instanceLocations).toHaveLength(0);
    });

    it("skips a descriptor whose resolved location is < 0", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array(8));
        mock.clear();
        bindAttributes(engine, vb, [{ index: -1, size: 2, offset: 0 }], eff);
        expect(callsNamed(mock, "vertexAttribPointer")).toHaveLength(0);
    });
});

describe("lite-gl mesh: drawIndexed", () => {
    it("non-instanced → drawElements with UNSIGNED_SHORT and byte offset", () => {
        const { mock, engine } = makeEngine();
        makeReadyEffect(engine);
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2, 3, 4, 5]));
        mock.clear();
        drawIndexed(engine, ib, 6, 0);
        const de = callsNamed(mock, "drawElements");
        expect(de).toHaveLength(1);
        expect(de[0]?.args).toEqual([engine.gl.TRIANGLES, 6, engine.gl.UNSIGNED_SHORT, 0]);
        expect(callsNamed(mock, "drawElementsInstanced")).toHaveLength(0);
    });

    it("indexStart is converted to a byte offset (×2 for 16-bit)", () => {
        const { mock, engine } = makeEngine();
        makeReadyEffect(engine);
        const ib = createIndexBuffer(engine, new Uint16Array(12));
        mock.clear();
        drawIndexed(engine, ib, 6, 3);
        expect(callsNamed(mock, "drawElements")[0]?.args[3]).toBe(6);
    });

    it("32-bit index buffer draws with UNSIGNED_INT and ×4 byte offset", () => {
        const { mock, engine } = makeEngine();
        makeReadyEffect(engine);
        const ib = createIndexBuffer(engine, new Uint32Array(12));
        mock.clear();
        drawIndexed(engine, ib, 6, 2);
        const de = callsNamed(mock, "drawElements")[0];
        expect(de?.args[2]).toBe(engine.gl.UNSIGNED_INT);
        expect(de?.args[3]).toBe(8);
    });

    it("instanceCount > 0 → drawElementsInstanced", () => {
        const { mock, engine } = makeEngine();
        makeReadyEffect(engine);
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2, 3, 4, 5]));
        mock.clear();
        drawIndexed(engine, ib, 6, 0, 32);
        const di = callsNamed(mock, "drawElementsInstanced");
        expect(di).toHaveLength(1);
        expect(di[0]?.args).toEqual([engine.gl.TRIANGLES, 6, engine.gl.UNSIGNED_SHORT, 0, 32]);
        expect(callsNamed(mock, "drawElements")).toHaveLength(0);
    });

    it("is a no-op when no program is current", () => {
        const { mock, engine } = makeEngine();
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        engine._state.currentProgram = null;
        mock.clear();
        drawIndexed(engine, ib, 3);
        expect(callsNamed(mock, "drawElements")).toHaveLength(0);
    });
});

describe("lite-gl mesh: lifecycle", () => {
    it("disposeBuffer deletes the GL buffer and clears the cache slot", () => {
        const { mock, engine } = makeEngine();
        const vb = createVertexBuffer(engine, new Float32Array([1, 2]));
        expect(engine._state.boundArrayBuffer).toBe(vb.handle);
        disposeBuffer(engine, vb);
        expect(callsNamed(mock, "deleteBuffer")).toHaveLength(1);
        expect(engine._buffers).toHaveLength(0);
        expect(engine._state.boundArrayBuffer).toBeNull();
    });

    it("disposeBuffer is idempotent", () => {
        const { mock, engine } = makeEngine();
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        disposeBuffer(engine, ib);
        mock.clear();
        disposeBuffer(engine, ib);
        expect(callsNamed(mock, "deleteBuffer")).toHaveLength(0);
    });

    it("re-uploads retained data on webglcontextrestored", () => {
        const { mock, canvas, engine } = makeEngine();
        const data = new Float32Array([7, 8, 9]);
        const vb = createVertexBuffer(engine, data);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        const bd = callsNamed(mock, "bufferData");
        expect(bd).toHaveLength(1);
        expect(bd[0]?.args[1]).toBe(data);
        // Handle was swapped for a fresh one.
        expect(vb.handle).not.toBeNull();
    });

    it("engine dispose frees all registered buffers", () => {
        const { mock, engine } = makeEngine();
        createVertexBuffer(engine, new Float32Array([1]));
        createIndexBuffer(engine, new Uint16Array([0]));
        mock.clear();
        disposeGLEngine(engine);
        expect(callsNamed(mock, "deleteBuffer")).toHaveLength(2);
        expect(engine._buffers).toHaveLength(0);
    });
});

describe("lite-gl mesh: static mesh VAO (createMeshVao / drawMesh)", () => {
    function meshEffect(engine: ReturnType<typeof makeEngine>["engine"]) {
        const eff = createEffect(engine, {
            name: "mesh-vao",
            vertexSource: "v",
            fragmentSource: "f",
            uniformNames: [],
            samplerNames: [],
            attributeNames: ["a_pos", "a_color"],
        });
        isEffectReady(engine, eff);
        return eff;
    }

    it("records the attribute layout into ONE VAO and leaves the default VAO bound", () => {
        const { mock, engine } = makeEngine();
        const effect = meshEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0, 1, 1, 1]));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        mock.clear();
        const vao = createMeshVao(
            engine,
            [
                {
                    buffer: vb,
                    attributes: [
                        { name: "a_pos", size: 3, offset: 0, divisor: 0 },
                        { name: "a_color", size: 3, offset: 12, divisor: 0 },
                    ],
                    computeStride: true,
                },
            ],
            ib,
            effect
        );
        expect(vao.handle).not.toBeNull();
        expect(mock.count("createVertexArray")).toBe(1);
        // Both attributes recorded once → two pointer + two divisor calls.
        expect(mock.count("vertexAttribPointer")).toBe(2);
        expect(mock.count("vertexAttribDivisor")).toBe(2);
        // Recording ends back on the default (null) VAO — the mesh VAO is not left current.
        expect(engine._state.boundVao).toBeNull();
    });

    it("drawMesh issues ZERO per-frame attribute calls (the VAO win) and binds the VAO once", () => {
        const { mock, engine } = makeEngine();
        const effect = meshEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0]));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const vao = createMeshVao(engine, [{ buffer: vb, attributes: [{ name: "a_pos", size: 3, divisor: 0 }], computeStride: true }], ib, effect);
        useEffect(engine, effect); // drawMesh needs a current program
        mock.clear();
        drawMesh(engine, vao);
        drawMesh(engine, vao);
        // No vertexAttribPointer/Divisor on the per-frame draw — the VAO replays them.
        expect(mock.count("vertexAttribPointer")).toBe(0);
        expect(mock.count("vertexAttribDivisor")).toBe(0);
        // First draw binds the VAO; the second is elided (already current).
        expect(mock.count("bindVertexArray")).toBe(1);
        expect(mock.count("drawElements")).toBe(2);
    });

    it("drawMesh issues drawElementsInstanced when instanceCount > 0", () => {
        const { mock, engine } = makeEngine();
        const effect = meshEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0]));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const vao = createMeshVao(engine, [{ buffer: vb, attributes: [{ name: "a_pos", size: 3, divisor: 0 }], computeStride: true }], ib, effect);
        useEffect(engine, effect);
        mock.clear();
        drawMesh(engine, vao, 5);
        const di = callsNamed(mock, "drawElementsInstanced");
        expect(di).toHaveLength(1);
        expect(di[0]?.args[4]).toBe(5); // instanceCount
        expect(mock.count("drawElements")).toBe(0);
    });

    it("re-records the VAO on webglcontextrestored (fresh handle, captured locations)", () => {
        const { mock, canvas, engine } = makeEngine();
        const effect = meshEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0]));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        createMeshVao(engine, [{ buffer: vb, attributes: [{ name: "a_pos", size: 3, divisor: 0 }], computeStride: true }], ib, effect);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        // The VAO is rebuilt + re-recorded AFTER its buffers restore (no effect needed).
        expect(mock.count("createVertexArray")).toBe(1);
        expect(mock.count("vertexAttribPointer")).toBe(1);
    });

    it("disposeMeshVao deletes the VAO and unregisters its restore hook", () => {
        const { mock, canvas, engine } = makeEngine();
        const effect = meshEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0]));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const vao = createMeshVao(engine, [{ buffer: vb, attributes: [{ name: "a_pos", size: 3, divisor: 0 }], computeStride: true }], ib, effect);
        disposeMeshVao(engine, vao);
        expect(mock.count("deleteVertexArray")).toBe(1);
        // A later restore must NOT re-record the disposed VAO.
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("createVertexArray")).toBe(0);
    });
});

describe("lite-gl mesh: VAO effect-readiness guard", () => {
    it("createMeshVao throws when the effect is not ready (avoids a silently-empty VAO)", () => {
        const { engine } = makeEngine();
        const effect = createEffect(engine, {
            name: "mesh-vao-unready",
            vertexSource: "v",
            fragmentSource: "f",
            uniformNames: [],
            samplerNames: [],
            attributeNames: ["a_pos"],
        });
        // Intentionally NOT calling isEffectReady → effect.isReady stays false.
        const vb = createVertexBuffer(engine, new Float32Array([0, 0, 0]));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        expect(() => createMeshVao(engine, [{ buffer: vb, attributes: [{ name: "a_pos", size: 3 }] }], ib, effect)).toThrow(/ready/);
    });
});
