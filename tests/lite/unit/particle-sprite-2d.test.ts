import { describe, expect, it, vi } from "vitest";

const globals = globalThis as unknown as Record<string, unknown>;
globals.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
globals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globals.GPUColorWrite ??= { ALL: 0xf };

import { spawnParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import {
    createParticleSprite2DBridge,
    disposeNodeParticleSet2DBinding,
    registerNodeParticleSet2D,
    syncParticleSprite2DBridge,
} from "../../../packages/babylon-lite/src/particle/particle-sprite-2d";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { NodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
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

function mockEngine(): EngineContext {
    const device = {
        createBuffer: vi.fn(mockBuffer),
        createShaderModule: vi.fn(() => ({})),
        createBindGroupLayout: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
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

function makeSystem(capacity = 4) {
    const system = createParticleSystem(capacity);
    system.texture = mockTexture();
    return system;
}

function makeSet(...systems: ReturnType<typeof createParticleSystem>[]): NodeParticleSet {
    return { systems, _graph: {} as never };
}

function addParticle(
    system: ReturnType<typeof createParticleSystem>,
    values: {
        x: number;
        y: number;
        size: number;
        scaleX: number;
        scaleY: number;
        angle: number;
        color: [number, number, number, number];
    }
): number {
    const i = spawnParticle(system.buffer);
    system.buffer.posX[i] = values.x;
    system.buffer.posY[i] = values.y;
    system.buffer.size[i] = values.size;
    system.buffer.scaleX[i] = values.scaleX;
    system.buffer.scaleY[i] = values.scaleY;
    system.buffer.angle[i] = values.angle;
    system.buffer.colorR[i] = values.color[0];
    system.buffer.colorG[i] = values.color[1];
    system.buffer.colorB[i] = values.color[2];
    system.buffer.colorA[i] = values.color[3];
    return i;
}

describe("NPE Sprite2D bridge", () => {
    it("requires the graph texture to be ready", () => {
        const system = createParticleSystem(1);
        expect(() => createParticleSprite2DBridge(system)).toThrow(/has no texture/);
    });

    it("registers every system with a renderer and advances it automatically", () => {
        const engine = mockEngine();
        const renderer = createSpriteRenderer(engine, { layers: [] });
        const first = makeSystem();
        const second = makeSystem();
        first.emitRate = 60;
        second.emitRate = 60;
        first.updateSpeed = 1 / 60;
        second.updateSpeed = 1 / 60;

        const binding = registerNodeParticleSet2D(renderer, makeSet(first, second));

        expect(binding.active).toBe(true);
        expect(binding.bridges).toHaveLength(2);
        expect(renderer.layers).toEqual(binding.bridges.map((bridge) => bridge.layer));
        expect(renderer._beforeUpdate).toHaveLength(1);
        expect(renderer._disposeCallbacks).toHaveLength(1);
        expect(first._started).toBe(true);
        expect(second._started).toBe(true);

        renderer._beforeUpdate[0]!(1000 / 60);
        expect(first.buffer.alive).toBe(1);
        expect(second.buffer.alive).toBe(1);
        expect(binding.bridges[0]!.layer.count).toBe(1);
        expect(binding.bridges[1]!.layer.count).toBe(1);

        disposeNodeParticleSet2DBinding(binding);
        disposeSpriteRenderer(renderer);
    });

    it("can attach without auto-starting, then detach idempotently", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const system = makeSystem();
        const binding = registerNodeParticleSet2D(renderer, makeSet(system), { autoStart: false });

        renderer._beforeUpdate[0]!(1000 / 60);
        expect(system._started).toBe(false);
        expect(system.buffer.alive).toBe(0);

        disposeNodeParticleSet2DBinding(binding);
        expect(binding.active).toBe(false);
        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);

        expect(() => disposeNodeParticleSet2DBinding(binding)).not.toThrow();
        disposeSpriteRenderer(renderer);
    });

    it("does not partially attach a set when a later system is invalid", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const valid = makeSystem();
        const invalid = createParticleSystem(1); // no texture

        expect(() => registerNodeParticleSet2D(renderer, makeSet(valid, invalid))).toThrow(/has no texture/);

        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
        expect(valid._started).toBe(false);
        disposeSpriteRenderer(renderer);
    });

    it("detaches automatically when the renderer is disposed", () => {
        const renderer = createSpriteRenderer(mockEngine(), { layers: [] });
        const binding = registerNodeParticleSet2D(renderer, makeSet(makeSystem()));

        disposeSpriteRenderer(renderer);

        expect(binding.active).toBe(false);
        expect(renderer.layers).toEqual([]);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
    });

    it("creates a centered pure-2D layer with NPE additive blending", () => {
        const system = makeSystem(7);
        system.blendMode = 2;

        const bridge = createParticleSprite2DBridge(system, {
            layer: { order: 9, opacity: 0.75, visible: false, view: { zoom: 2 } },
        });

        expect(bridge.layer._capacity).toBe(7);
        expect(bridge.layer.depth).toBe("none");
        expect(bridge.layer.pivot).toEqual([0.5, 0.5]);
        expect(bridge.layer.blendMode._key).toBe("additive");
        expect(bridge.layer.order).toBe(9);
        expect(bridge.layer.opacity).toBe(0.75);
        expect(bridge.layer.visible).toBe(false);
        expect(bridge.layer.view.zoom).toBe(2);
    });

    it("maps STANDARD, ONEONE, and ADD blend modes exactly", () => {
        const standard = makeSystem();
        standard.blendMode = 1;
        expect(createParticleSprite2DBridge(standard).layer.blendMode._key).toBe("alpha");

        const oneOne = makeSystem();
        oneOne.blendMode = 0;
        expect(createParticleSprite2DBridge(oneOne).layer.blendMode._key).toBe("oneone");

        const add = makeSystem();
        add.blendMode = 2;
        expect(createParticleSprite2DBridge(add).layer.blendMode._key).toBe("additive");
    });

    it("converts NPE Y-up world values into Sprite2D Y-down pixels by default", () => {
        const system = makeSystem();
        addParticle(system, {
            x: 3,
            y: 4,
            size: 5,
            scaleX: 2,
            scaleY: 0.5,
            angle: 0.75,
            color: [0.1, 0.2, 0.3, 0.4],
        });
        const bridge = createParticleSprite2DBridge(system, {
            pixelsPerUnit: 10,
            originPx: [100, 200],
        });

        syncParticleSprite2DBridge(bridge);

        expect(bridge.layer.count).toBe(1);
        expect(Array.from(bridge.layer._instanceData.slice(0, 4))).toEqual([130, 160, 100, 25]);
        expect(bridge.layer._instanceData[8]).toBeCloseTo(-0.75);
        expect(Array.from(bridge.layer._instanceData.slice(9, 13))).toEqual([expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3), expect.closeTo(0.4)]);
        expect(Array.from(bridge.layer._savedSize.slice(0, 2))).toEqual([100, 25]);
    });

    it("can preserve NPE Y-up coordinates when inversion is disabled", () => {
        const system = makeSystem();
        addParticle(system, { x: 2, y: 3, size: 1, scaleX: 1, scaleY: 1, angle: 0.5, color: [1, 1, 1, 1] });
        const bridge = createParticleSprite2DBridge(system, { pixelsPerUnit: 4, originPx: [10, 20], invertY: false });

        syncParticleSprite2DBridge(bridge);

        expect(Array.from(bridge.layer._instanceData.slice(0, 2))).toEqual([18, 32]);
        expect(bridge.layer._instanceData[8]).toBeCloseTo(0.5);
    });

    it("uses the NPE sprite-sheet cell index for atlas UVs", () => {
        const system = makeSystem(2);
        const cellIndex = new Uint16Array(2);
        system._spriteSheet = { cellWidth: 16, cellHeight: 16, cellIndex, update: () => undefined };
        addParticle(system, { x: 0, y: 0, size: 1, scaleX: 1, scaleY: 1, angle: 0, color: [1, 1, 1, 1] });
        cellIndex[0] = 5;
        const bridge = createParticleSprite2DBridge(system);

        syncParticleSprite2DBridge(bridge);

        expect(bridge.layer.atlas.frames).toHaveLength(8);
        expect(Array.from(bridge.layer._instanceData.slice(4, 8))).toEqual([0.25, 0.5, 0.5, 1]);
    });

    it("replaces the complete live range and marks one dirty update per sync", () => {
        const system = makeSystem(3);
        addParticle(system, { x: 1, y: 1, size: 1, scaleX: 1, scaleY: 1, angle: 0, color: [1, 1, 1, 1] });
        addParticle(system, { x: 2, y: 2, size: 2, scaleX: 1, scaleY: 1, angle: 0, color: [1, 1, 1, 1] });
        const bridge = createParticleSprite2DBridge(system);
        const instanceData = bridge.layer._instanceData;

        syncParticleSprite2DBridge(bridge);
        expect(bridge.layer.count).toBe(2);
        expect(bridge.layer._version).toBe(1);

        system.buffer.alive = 1;
        syncParticleSprite2DBridge(bridge);
        expect(bridge.layer.count).toBe(1);
        expect(bridge.layer._version).toBe(2);
        expect(bridge.layer._instanceData).toBe(instanceData);
        expect(Array.from(bridge.layer._savedSize.slice(2, 4))).toEqual([0, 0]);

        system.buffer.alive = 0;
        syncParticleSprite2DBridge(bridge);
        expect(bridge.layer.count).toBe(0);
        expect(bridge.layer._version).toBe(3);
    });

    it("validates mutable mapping values at creation and sync", () => {
        const system = makeSystem();
        expect(() => createParticleSprite2DBridge(system, { pixelsPerUnit: 0 })).toThrow(/pixelsPerUnit/);
        expect(() => createParticleSprite2DBridge(system, { originPx: [Number.NaN, 0] })).toThrow(/originPx/);

        const bridge = createParticleSprite2DBridge(system);
        bridge.pixelsPerUnit = Number.POSITIVE_INFINITY;
        expect(() => syncParticleSprite2DBridge(bridge)).toThrow(/pixelsPerUnit/);
        bridge.pixelsPerUnit = 1;
        bridge.originPx[1] = Number.NaN;
        expect(() => syncParticleSprite2DBridge(bridge)).toThrow(/originPx/);
    });
});
