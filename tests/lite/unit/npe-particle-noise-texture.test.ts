import { afterEach, describe, expect, it, vi } from "vitest";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { animateParticleSystem, createParticleSystem, startParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { killParticle, spawnParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import { updateNoiseBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/update-noise-block";
import { buildNodeParticleSetWithNoiseTextures } from "../../../packages/babylon-lite/src/particle/node/npe-noise";
import { buildNodeParticleSetWithTextureUpdates } from "../../../packages/babylon-lite/src/particle/node/npe-texture-updates";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { NpeGetter, NpeTextureContent, NpeTextureValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import truth from "./fixtures/noise-texture-states.json";

async function attachNoise(map: NpeTextureContent, strength: Vec3, capacity = 1) {
    const system = createParticleSystem(capacity);
    const source: NpeTextureValue = { url: "noise.png", invertY: false, _content: Promise.resolve(map) };
    const promises: Promise<void>[] = [];
    const ctx = {
        state: { system, buffer: system.buffer },
        input(_block: ParsedParticleBlock, name: string): NpeGetter {
            return name === "noiseTexture" ? ((() => source) as unknown as NpeGetter) : () => strength;
        },
        addBuildPromise(promise: Promise<void>) {
            promises.push(promise);
        },
    } as unknown as NpeBuildContext;
    const block = { id: 1, className: "UpdateNoiseBlock", name: "noise", inputs: [], serialized: {} } as ParsedParticleBlock;
    updateNoiseBlock.build(block, ctx);
    await Promise.all(promises);
    return system;
}

async function attachNoiseWithGetters(sourceGetter: NpeGetter, strengthGetter?: NpeGetter) {
    const system = createParticleSystem(2);
    const promises: Promise<void>[] = [];
    const ctx = {
        state: { system, buffer: system.buffer },
        input(_block: ParsedParticleBlock, name: string, fallback?: NpeGetter): NpeGetter {
            return name === "noiseTexture" ? sourceGetter : (strengthGetter ?? fallback!);
        },
        addBuildPromise(promise: Promise<void>) {
            promises.push(promise);
        },
    } as unknown as NpeBuildContext;
    const block = { id: 1, className: "UpdateNoiseBlock", name: "noise", inputs: [], serialized: {} } as ParsedParticleBlock;
    updateNoiseBlock.build(block, ctx);
    await Promise.all(promises);
    return system;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("NPE UpdateNoiseBlock", () => {
    it("samples three red texels with per-axis strength and the current scaled step", async () => {
        const data = new Uint8ClampedArray(4 * 4 * 4);
        data[(2 + 2 * 4) * 4] = 255;
        data[(3 + 2 * 4) * 4] = 0;
        data[(2 + 3 * 4) * 4] = 128;
        const system = await attachNoise({ width: 4, height: 4, data }, { x: 2, y: 3, z: 4 });
        const draws = [0, 0, 0.6, 0, 0, 0.6];
        vi.spyOn(Math, "random").mockImplementation(() => draws.shift()!);
        system.buffer.dirX[0] = 1;
        system.buffer.dirY[0] = 1;
        system.buffer.dirZ[0] = 1;
        system._scaledStep = 0.5;

        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(2, 6);
        expect(system.buffer.dirY[0]).toBeCloseTo(-0.5, 6);
        expect(system.buffer.dirZ[0]).toBeCloseTo(1 + 2 / 255, 6);
        expect(draws).toHaveLength(0);
    });

    it("reuses coordinates for a particle and regenerates them when its slot is recycled", async () => {
        const data = new Uint8ClampedArray(4 * 4 * 4);
        data.fill(255);
        const system = await attachNoise({ width: 4, height: 4, data }, { x: 1, y: 1, z: 1 });
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        spawnParticle(system.buffer);
        system._scaledStep = 1;

        system.updateSteps[0]!(0);
        system.updateSteps[0]!(0);
        expect(random).toHaveBeenCalledTimes(6);

        killParticle(system.buffer, 0);
        spawnParticle(system.buffer);
        system.updateSteps[0]!(0);
        expect(random).toHaveBeenCalledTimes(12);
    });

    it("uses the Babylon Vector3 default and consumes no random values when texture extraction fails", async () => {
        const source: NpeTextureValue = { url: "noise.png", invertY: false, _content: Promise.reject(new Error("decode failed")) };
        const system = await attachNoiseWithGetters((() => source) as unknown as NpeGetter);
        const random = vi.spyOn(Math, "random");
        system._scaledStep = 1;

        system.updateSteps[0]!(0);

        expect(random).not.toHaveBeenCalled();
        expect(system.buffer.dirX[0]).toBe(0);
    });

    it("applies the Babylon default strength of 100 on every axis", async () => {
        const data = new Uint8ClampedArray([255, 0, 0, 255]);
        const source: NpeTextureValue = { url: "noise.png", invertY: false, _content: Promise.resolve({ width: 1, height: 1, data }) };
        const system = await attachNoiseWithGetters((() => source) as unknown as NpeGetter);
        vi.spyOn(Math, "random").mockReturnValue(0);
        system._scaledStep = 0.25;

        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBe(25);
        expect(system.buffer.dirY[0]).toBe(25);
        expect(system.buffer.dirZ[0]).toBe(25);
    });

    it("resolves strength once during build and retains the returned Vector3", async () => {
        const data = new Uint8ClampedArray([255, 0, 0, 255]);
        const source: NpeTextureValue = { url: "noise.png", invertY: false, _content: Promise.resolve({ width: 1, height: 1, data }) };
        const strength = { x: 1, y: 2, z: 3 };
        const strengthGetter = vi.fn(() => strength);
        const system = await attachNoiseWithGetters((() => source) as unknown as NpeGetter, strengthGetter);
        vi.spyOn(Math, "random").mockReturnValue(0);
        strength.x = 4;
        system._scaledStep = 1;

        system.updateSteps[0]!(0);
        system.updateSteps[0]!(0);

        expect(strengthGetter).toHaveBeenCalledOnce();
        expect(system.buffer.dirX[0]).toBe(8);
    });

    it("reproduces Babylon.js multi-step noise coordinates and direction states", async () => {
        const data = new Uint8ClampedArray(4 * 4 * 4);
        for (let i = 0; i < 16; i++) {
            data[i * 4] = i * 16;
            data[i * 4 + 3] = 255;
        }
        const system = await attachNoise({ width: 4, height: 4, data }, { x: 2, y: 3, z: 4 }, 4);
        system.emitRate = 10;
        system.updateSpeed = 0.1;
        system.createLifeTime = (i) => {
            system.buffer.lifeTime[i] = 1;
        };
        system.createDirection = (i) => {
            system.buffer.dirX[i] = 0;
            system.buffer.dirY[i] = 1;
            system.buffer.dirZ[i] = 0;
        };
        let seed = 1;
        vi.spyOn(Math, "random").mockImplementation(() => {
            const value = Math.sin(seed++) * 10000;
            return value - Math.floor(value);
        });
        startParticleSystem(system);
        for (let step = 0; step < 6; step++) {
            animateParticleSystem(system, 1);
        }

        const coord1X = system.buffer._columns.get("noise.coord1.x")!;
        const coord1Y = system.buffer._columns.get("noise.coord1.y")!;
        const coord1Z = system.buffer._columns.get("noise.coord1.z")!;
        const coord2X = system.buffer._columns.get("noise.coord2.x")!;
        const coord2Y = system.buffer._columns.get("noise.coord2.y")!;
        const coord2Z = system.buffer._columns.get("noise.coord2.z")!;
        expect(system.buffer.alive).toBe(truth.length);
        for (let i = 0; i < truth.length; i++) {
            const expected = truth[i]!;
            expect(system.buffer.id[i]).toBe(expected.id);
            expect(system.buffer.age[i]).toBeCloseTo(expected.age, 12);
            expect(system.buffer.lifeTime[i]).toBeCloseTo(expected.lifeTime, 12);
            expect(system.buffer.dirX[i]).toBeCloseTo(expected.direction[0]!, 6);
            expect(system.buffer.dirY[i]).toBeCloseTo(expected.direction[1]!, 6);
            expect(system.buffer.dirZ[i]).toBeCloseTo(expected.direction[2]!, 6);
            expect(coord1X[i]).toBeCloseTo(expected.noise1[0]!, 12);
            expect(coord1Y[i]).toBeCloseTo(expected.noise1[1]!, 12);
            expect(coord1Z[i]).toBeCloseTo(expected.noise1[2]!, 12);
            expect(coord2X[i]).toBeCloseTo(expected.noise2[0]!, 12);
            expect(coord2Y[i]).toBeCloseTo(expected.noise2[1]!, 12);
            expect(coord2Z[i]).toBeCloseTo(expected.noise2[2]!, 12);
        }
    });

    it("builds UpdateNoiseBlock and its CPU texture dependency from a parsed graph", async () => {
        const data = new Uint8ClampedArray(4 * 4 * 4);
        data[(2 + 2 * 4) * 4] = 255;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, blob: async () => ({}) }))
        );
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() }))
        );
        vi.stubGlobal(
            "OffscreenCanvas",
            vi.fn(function (this: { getContext: () => unknown }) {
                this.getContext = () => ({ drawImage: vi.fn(), getImageData: () => ({ data }) });
            })
        );
        const graph = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.SystemBlock", id: 5, capacity: 1, inputs: [{ name: "particle", targetBlockId: 3, targetConnectionName: "output" }] },
                {
                    customType: "BABYLON.UpdateNoiseBlock",
                    id: 3,
                    inputs: [
                        { name: "particle", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "noiseTexture", targetBlockId: 2, targetConnectionName: "texture" },
                        { name: "strength", targetBlockId: 4, targetConnectionName: "output" },
                    ],
                },
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, textureDataUrl: "data:image/png;base64,AA==", invertY: false, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 4, type: 8, valueType: "BABYLON.Vector3", value: [2, 3, 4], inputs: [] },
            ],
        });
        const set = await buildNodeParticleSetWithNoiseTextures({} as never, {} as never, graph);
        const system = set.systems[0]!;
        vi.spyOn(Math, "random").mockReturnValue(0);
        system._scaledStep = 0.5;

        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(1, 6);
        expect(system.buffer.dirY[0]).toBeCloseTo(1.5, 6);
        expect(system.buffer.dirZ[0]).toBeCloseTo(2, 6);
    });

    it("builds combined flow-map and noise updates with one shared CPU texture", async () => {
        const data = new Uint8ClampedArray([255, 128, 128, 255]);
        const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({}) }));
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        vi.stubGlobal(
            "OffscreenCanvas",
            vi.fn(function (this: { getContext: () => unknown }) {
                this.getContext = () => ({ drawImage: vi.fn(), getImageData: () => ({ data }) });
            })
        );
        const scene = {
            camera: createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 }),
            surface: { canvas: { width: 100, height: 100 } },
            _beforeRender: [],
            _deferredBuilders: [],
        } as unknown as SceneContext;
        const graph = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.SystemBlock", id: 7, capacity: 1, inputs: [{ name: "particle", targetBlockId: 6, targetConnectionName: "output" }] },
                {
                    customType: "BABYLON.UpdateNoiseBlock",
                    id: 6,
                    inputs: [
                        { name: "particle", targetBlockId: 5, targetConnectionName: "output" },
                        { name: "noiseTexture", targetBlockId: 2, targetConnectionName: "texture" },
                        { name: "strength", targetBlockId: 4, targetConnectionName: "output" },
                    ],
                },
                {
                    customType: "BABYLON.UpdateFlowMapBlock",
                    id: 5,
                    inputs: [
                        { name: "particle", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "flowMap", targetBlockId: 2, targetConnectionName: "texture" },
                        { name: "strength", targetBlockId: 3, targetConnectionName: "output" },
                    ],
                },
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, textureDataUrl: "data:image/png;base64,AA==", invertY: false, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 3, type: 2, value: 2, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 4, type: 8, value: [3, 0, 0], inputs: [] },
            ],
        });
        const set = await buildNodeParticleSetWithTextureUpdates({} as never, scene, graph);
        const system = set.systems[0]!;
        vi.spyOn(Math, "random").mockReturnValue(0);
        system._scaledStep = 1;

        expect(system.updateSteps).toHaveLength(2);
        system.updateSteps[0]!(0);
        system.updateSteps[1]!(0);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(system.buffer.dirX[0]).toBeCloseTo(5, 6);
    });
});
