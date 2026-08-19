import { describe, expect, it, vi } from "vitest";

const globals = globalThis as unknown as Record<string, unknown>;
globals.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
globals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globals.GPUColorWrite ??= { ALL: 0xf };

import { spawnParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import {
    createParticleSprite2DBridgeWithBlendModes,
    disposeNodeParticleSet2DBlendModesBinding,
    registerNodeParticleSet2DWithBlendModes,
    syncParticleSprite2DBridgeWithBlendModes,
} from "../../../packages/babylon-lite/src/particle/particle-sprite-2d-blend-modes";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { NodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { addSprite2D } from "../../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { createSpriteRenderer, disposeSpriteRenderer } from "../../../packages/babylon-lite/src/sprite/sprite-renderer";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function mockBuffer() {
    return {
        destroy: vi.fn(),
        getMappedRange: vi.fn(() => new ArrayBuffer(64)),
        unmap: vi.fn(),
    };
}

function mockEngine(failPipelineAt = 0): EngineContext {
    let pipelineCount = 0;
    const device = {
        createBuffer: vi.fn(mockBuffer),
        createShaderModule: vi.fn(() => ({})),
        createBindGroupLayout: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => {
            pipelineCount++;
            if (pipelineCount === failPipelineAt) {
                throw new Error("pipeline failure");
            }
            return { getBindGroupLayout: vi.fn(() => ({})) };
        }),
        createBindGroup: vi.fn(() => ({})),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        format: "bgra8unorm",
        _device: device,
        _renderingContexts: [],
        _currentDelta: 1000 / 60,
        scRT: { _width: 800, _height: 600 },
    } as unknown as EngineContext;
    Object.assign(engine, { engine, surfaces: [engine], _surfaces: [engine] });
    return engine;
}

function mockTexture(width = 64, height = 32): Texture2D {
    return {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width,
        height,
    } as Texture2D;
}

function makeSystem(blendMode = 2, capacity = 4) {
    const system = createParticleSystem(capacity);
    system.texture = mockTexture();
    system.blendMode = blendMode;
    return system;
}

function makeSet(...systems: ReturnType<typeof createParticleSystem>[]): NodeParticleSet {
    return { systems, _graph: {} as never };
}

function addParticle(system: ReturnType<typeof createParticleSystem>): void {
    const index = spawnParticle(system.buffer);
    system.buffer.posX[index] = 2;
    system.buffer.posY[index] = 3;
    system.buffer.size[index] = 4;
    system.buffer.scaleX[index] = 2;
    system.buffer.scaleY[index] = 0.5;
    system.buffer.angle[index] = 0.25;
    system.buffer.colorR[index] = 0.1;
    system.buffer.colorG[index] = 0.2;
    system.buffer.colorB[index] = 0.3;
    system.buffer.colorA[index] = 0.4;
}

const ONE_ONE = {
    color: { srcFactor: "one", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
};
const STANDARD = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};
const ADD = {
    color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
};
const MULTIPLY = {
    color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};

describe("NPE Sprite2D exact blend modes", () => {
    it("maps modes 0 through 4 and unknown values to exact descriptors", () => {
        const expected = [ONE_ONE, STANDARD, ADD, MULTIPLY, MULTIPLY, ADD];

        for (const [index, mode] of [0, 1, 2, 3, 4, 99].entries()) {
            const bridge = createParticleSprite2DBridgeWithBlendModes(makeSystem(mode));
            expect(bridge.layer.blendMode._descriptor, `blendMode ${mode}`).toEqual(expected[index]);
        }
    });

    it("creates one Multiply layer with the exact alpha-to-white Sprite2D fragment", () => {
        const bridge = createParticleSprite2DBridgeWithBlendModes(makeSystem(3));

        expect(bridge.layers).toEqual([bridge.layer]);
        expect(bridge.layer.blendMode._key).toBe("p3");
        const wgsl = bridge.layer.customShader?._composeWgsl(false, 0, false);
        expect(wgsl).toContain("sampled * in.tint * L.opacityMul");
        expect(wgsl).toContain("sampled.a * in.tint.a * L.opacityMul.a");
        expect(wgsl).toContain("baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha)");
    });

    it("creates MultiplyAdd as consecutive equal-order Multiply then Add layers", () => {
        const bridge = createParticleSprite2DBridgeWithBlendModes(makeSystem(4), { layer: { order: 7, opacity: 0.6 } });

        expect(bridge.layers).toHaveLength(2);
        expect(bridge.layers[0]).toBe(bridge.layer);
        expect(bridge.layers.map((layer) => layer.blendMode._key)).toEqual(["p4", "p2"]);
        expect(bridge.layers.map((layer) => layer.order)).toEqual([7, 7]);
        expect(bridge.layers.map((layer) => layer.opacity)).toEqual([0.6, 0.6]);
        expect(bridge.layers[0]!.customShader).toBeDefined();
        expect(bridge.layers[1]!.customShader).toBeUndefined();
    });

    it("synchronizes both passes from one mutable mapping and primary presentation state", () => {
        const system = makeSystem(4);
        addParticle(system);
        const bridge = createParticleSprite2DBridgeWithBlendModes(system);
        bridge.pixelsPerUnit = 10;
        bridge.originPx = [100, 200];
        bridge.layer.opacity = 0.35;
        bridge.layer.visible = false;
        bridge.layer.order = 11;
        bridge.layer.view.positionPx = [9, 8];
        bridge.layer.view.zoom = 2;
        bridge.layer.view.rotation = 0.5;

        syncParticleSprite2DBridgeWithBlendModes(bridge);

        expect(Array.from(bridge.layer._instanceData.slice(0, 4))).toEqual([120, 170, 80, 20]);
        expect(bridge.layer._instanceData[8]).toBeCloseTo(-0.25);
        expect(bridge.layers[1]!._instanceData).not.toBe(bridge.layer._instanceData);
        expect(Array.from(bridge.layers[1]!._instanceData)).toEqual(Array.from(bridge.layer._instanceData));
        expect(bridge.layers[1]!.opacity).toBe(0.35);
        expect(bridge.layers[1]!.visible).toBe(false);
        expect(bridge.layers[1]!.order).toBe(11);
        expect(bridge.layers[1]!.view).toEqual({ positionPx: [9, 8], zoom: 2, rotation: 0.5 });
    });

    it("animates each system once per renderer update, then synchronizes every pass", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const system = makeSystem(4);
        system.emitRate = 60;
        system.updateSpeed = 1 / 60;

        const binding = registerNodeParticleSet2DWithBlendModes(renderer, makeSet(system));
        renderer._beforeUpdate[0]!(1000 / 60);

        expect(system.buffer.alive).toBe(1);
        expect(binding.bridges[0]!.layers.map((layer) => layer.count)).toEqual([1, 1]);
        disposeNodeParticleSet2DBlendModesBinding(binding);
        disposeSpriteRenderer(renderer);
    });

    it("rejects Handle API ownership on any pass before mutating another pass", () => {
        const system = makeSystem(4);
        addParticle(system);
        const bridge = createParticleSprite2DBridgeWithBlendModes(system);
        const primaryVersion = bridge.layer._version;
        addSprite2D(bridge.layers[1]!, { positionPx: [0, 0] });

        expect(() => syncParticleSprite2DBridgeWithBlendModes(bridge)).toThrow(/bridge-owned layers cannot use the Sprite2D Handle API/);
        expect(bridge.layer._version).toBe(primaryVersion);
    });

    it("does not attach or start any system when later bridge creation fails", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const valid = makeSystem(3);
        const invalid = createParticleSystem(1);

        expect(() => registerNodeParticleSet2DWithBlendModes(renderer, makeSet(valid, invalid))).toThrow(/has no texture/);
        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
        expect(valid._started).toBe(false);
        disposeSpriteRenderer(renderer);
    });

    it("rolls back every system and pass when later pipeline creation throws after a layer was pushed", () => {
        const renderer = createSpriteRenderer(mockEngine(3), { layers: [] });
        const first = makeSystem(3);
        const second = makeSystem(4);

        expect(() => registerNodeParticleSet2DWithBlendModes(renderer, makeSet(first, second))).toThrow(/pipeline failure/);
        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
        expect(first._started).toBe(false);
        expect(second._started).toBe(false);
        disposeSpriteRenderer(renderer);
    });

    it("detaches every pass explicitly and idempotently", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const binding = registerNodeParticleSet2DWithBlendModes(renderer, makeSet(makeSystem(4)));

        expect(renderer.layers).toEqual(binding.bridges[0]!.layers);
        disposeNodeParticleSet2DBlendModesBinding(binding);
        expect(binding.active).toBe(false);
        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
        expect(() => disposeNodeParticleSet2DBlendModesBinding(binding)).not.toThrow();
        disposeSpriteRenderer(renderer);
    });

    it("detaches every pass when its renderer is disposed", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const binding = registerNodeParticleSet2DWithBlendModes(renderer, makeSet(makeSystem(3), makeSystem(4)));

        disposeSpriteRenderer(renderer);

        expect(binding.active).toBe(false);
        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
    });
});
