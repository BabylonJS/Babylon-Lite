import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { MorphTargetData } from "../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstanceCount, setThinInstanceMatrix, setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { computeDirectionalLightMatrix, preloadDirectionalShadowBounds } from "../../../packages/babylon-lite/src/shadow/shadow-base";
import { getDirectionalShadowCaster, getShadowCasterWorldBounds, getThinInstanceWorldBounds } from "../../../packages/babylon-lite/src/shadow/thin-instance-shadow-bounds";

function matrix(scale = 1, x = 0): Mat4 {
    return new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, 0, 0, 1]) as unknown as Mat4;
}

function caster() {
    return initMeshTransform({ boundMin: [-50, -50, -50], boundMax: [50, 50, 50] });
}

function instances(...transforms: Mat4[]) {
    const mesh = caster();
    const matrices = new Float32Array(transforms.length * 16);
    for (let i = 0; i < transforms.length; i++) {
        matrices.set(transforms[i]!, i * 16);
    }
    setThinInstances(mesh, matrices, transforms.length);
    return mesh;
}

function engineStub(): EngineContext {
    const resource = () => ({});
    return {
        _device: {
            queue: { writeBuffer: vi.fn() },
            createBuffer: resource,
            createTexture: () => ({ createView: resource }),
            createSampler: resource,
            createShaderModule: resource,
            createBindGroupLayout: resource,
            createPipelineLayout: resource,
            createRenderPipeline: resource,
            createBindGroup: resource,
        },
        _currentEncoder: {
            beginRenderPass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }),
        },
    } as unknown as EngineContext;
}

function transformPoint(transform: ArrayLike<number>, point: number[]): number[] {
    return [0, 1, 2].map((axis) => transform[axis]! * point[0]! + transform[4 + axis]! * point[1]! + transform[8 + axis]! * point[2]! + transform[12 + axis]!);
}

function boxCorners(mesh: Mesh): number[][] {
    return Array.from({ length: 8 }, (_, corner) => [0, 1, 2].map((axis) => (corner & (1 << axis) ? mesh.boundMax![axis]! : mesh.boundMin![axis]!)));
}

function extrema(points: number[][]): { min: number[]; max: number[] } {
    return {
        min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))),
        max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))),
    };
}

describe("directional thin-instance shadow bounds", () => {
    it("preserves ESM blur tap selection across kernel quantization boundaries", async () => {
        const { createEsmDirectionalShadowGenerator } = await import("../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator");
        const engine = engineStub();
        const shader = vi.spyOn(engine._device, "createShaderModule");
        for (const requested of [1, 2, 3, 3.5, 4, 5, 6, 7, 7.5, 8, 63, 64, 65, 67, 68]) {
            const rounded = Math.round(Math.max(requested, 1));
            const candidates = [rounded, rounded - 1, rounded + 1, rounded - 2, rounded + 2];
            const expectedKernel = Math.max(
                candidates.find((candidate) => candidate > 0 && candidate % 4 === 1)!,
                3
            );
            createEsmDirectionalShadowGenerator(engine, createDirectionalLight([0, 0, 1]), { blurKernel: requested });
            const code = shader.mock.calls.at(-1)![0].code;
            const offsets = code.match(/OFFSETS=array<f32,(\d+)>/);
            expect(offsets).not.toBeNull();
            expect(Number(offsets![1])).toBe(Math.ceil(expectedKernel / 2));
        }
    });

    it("maps the configured near and far planes to the full WebGPU depth range", () => {
        const near = 3;
        const far = 53;
        const light = createDirectionalLight([0, 0, 1]);
        light.position.z = 7;
        const fit = computeDirectionalLightMatrix(light, [caster()], near, far);
        expect(transformPoint(fit._viewProj, [0, 0, light.position.z + near])[2]).toBeCloseTo(0);
        expect(transformPoint(fit._viewProj, [0, 0, light.position.z + far])[2]).toBeCloseTo(1);
    });

    it("caches ordinary caster bounds for camera-only refits and observes geometry and world changes", () => {
        const mesh = caster();
        mesh.position.x = 7;
        const first = getShadowCasterWorldBounds(mesh)!;
        const expected = extrema(boxCorners(mesh).map((point) => transformPoint(mesh.worldMatrix, point)));
        expect(first.min).toEqual(expected.min);
        expect(first.max).toEqual(expected.max);
        const world = vi.spyOn(mesh, "worldMatrix", "get");
        expect(getShadowCasterWorldBounds(mesh)).toBe(first);
        expect(world).not.toHaveBeenCalled();
        mesh.position.x++;
        expect(getShadowCasterWorldBounds(mesh)!.min[0]).toBe(expected.min[0]! + 1);
        mesh.boundMin![0] -= 2;
        expect(getShadowCasterWorldBounds(mesh)!.min[0]).toBe(expected.min[0]! - 1);
        world.mockRestore();
    });

    it("reuses lazy fit adapters without changing the source bounds or wrapping ordinary casters", () => {
        const plain = caster();
        expect(getDirectionalShadowCaster(plain)).toBe(plain);
        const mesh = instances(matrix(0.01));
        const adapter = getDirectionalShadowCaster(mesh)!;
        expect(getDirectionalShadowCaster(mesh)).toBe(adapter);
        expect(adapter.boundMin).toBe(getThinInstanceWorldBounds(mesh)!.min);
        setThinInstanceMatrix(mesh, 0, matrix(0.01, 2));
        expect(getDirectionalShadowCaster(mesh)).toBe(adapter);
        expect(adapter.boundMin![0]).toBeCloseTo(1.5);
        expect(mesh.boundMin).not.toBe(adapter.boundMin);
    });

    it("matches the eight-corner projection for mirrored, rotated and sheared mesh transforms", () => {
        const mesh = caster();
        mesh.boundMin = [-2, -1, -0.5];
        mesh.boundMax = [1, 3, 2];
        mesh.position.set(7, -3, 4);
        mesh.rotation.set(0.7, -0.4, 0.3);
        mesh.scaling.set(-2, 0.5, 1.5);
        mesh.parent = initMeshTransform({}, 3, -4, 5, 0.3, 0.2, 0.1, 2, -1, 0.7);
        const light = createDirectionalLight([0.3, -0.9, 0.1]);
        const fit = computeDirectionalLightMatrix(light, [mesh], 1, 100);
        const projected = extrema(boxCorners(mesh).map((point) => transformPoint(fit._viewProj, transformPoint(mesh.worldMatrix, point))));
        const control = caster();
        const controlFit = computeDirectionalLightMatrix(light, [control], 1, 100);
        const expected = extrema(boxCorners(control).map((point) => transformPoint(controlFit._viewProj, point)));
        for (let axis = 0; axis < 2; axis++) {
            expect(projected.min[axis]).toBeCloseTo(expected.min[axis]!, 5);
            expect(projected.max[axis]).toBeCloseTo(expected.max[axis]!, 5);
        }
    });

    it("matches transformed corners for off-center instance geometry under signed parent transforms", () => {
        const instance = matrix(-0.2, 3);
        const mesh = instances(instance);
        mesh.boundMin = [-2, -1, -0.5];
        mesh.boundMax = [1, 3, 2];
        mesh.rotation.set(0.7, -0.4, 0.3);
        mesh.scaling.set(-2, 0.5, 1.5);
        mesh.parent = initMeshTransform({}, 3, -4, 5, 0.3, 0.2, 0.1, 2, -1, 0.7);
        const expected = extrema(boxCorners(mesh).map((point) => transformPoint(mesh.worldMatrix, transformPoint(instance, point))));
        const actual = getThinInstanceWorldBounds(mesh)!;
        for (let axis = 0; axis < 3; axis++) {
            expect(actual.min[axis]).toBeCloseTo(expected.min[axis]!, 10);
            expect(actual.max[axis]).toBeCloseTo(expected.max[axis]!, 10);
        }
    });

    it("fits scaled and translated instances without overwriting the picking bounds", async () => {
        const mesh = instances(matrix(0.01), matrix(0.01, 2));
        const min = mesh.boundMin;
        const max = mesh.boundMax;
        const light = createDirectionalLight([0, 0, 1]);
        await preloadDirectionalShadowBounds([mesh]);

        const fit = computeDirectionalLightMatrix(light, [mesh], 1, 100);

        expect(2 / fit._viewProj[0]!).toBeCloseTo(3.6);
        expect(2 / fit._viewProj[5]!).toBeCloseTo(1.2);
        expect(mesh.boundMin).toBe(min);
        expect(mesh.boundMax).toBe(max);
        expect(mesh.boundMin).toEqual([-50, -50, -50]);
        expect(mesh.boundMax).toEqual([50, 50, 50]);
    });

    it("keeps the ordinary caster fit unchanged, including in a mixed caster list", async () => {
        const plain = caster();
        const thin = instances(matrix(0.01));
        const light = createDirectionalLight([0, 0, 1]);
        await preloadDirectionalShadowBounds([plain, thin]);
        const plainFit = computeDirectionalLightMatrix(light, [plain], 1, 100);
        const mixedFit = computeDirectionalLightMatrix(light, [plain, thin], 1, 100);

        expect(2 / plainFit._viewProj[0]!).toBeCloseTo(120);
        expect(mixedFit._viewProj).toEqual(plainFit._viewProj);
    });

    it("composes mesh and parent transforms after instance transforms and handles floating origin", async () => {
        const mesh = instances(matrix(0.01, 2));
        mesh.parent = initMeshTransform({}, 1000, 2000, 3000, 0, 0, Math.PI / 2, 2, 2, 2);
        mesh.position.x = 1;
        const bounds = getThinInstanceWorldBounds(mesh)!;
        expect(bounds.min[0]).toBeCloseTo(999);
        expect(bounds.max[0]).toBeCloseTo(1001);
        expect(bounds.min[1]).toBeCloseTo(2005);
        expect(bounds.max[1]).toBeCloseTo(2007);
        expect(bounds.min[2]).toBeCloseTo(2999);
        expect(bounds.max[2]).toBeCloseTo(3001);

        const light = createDirectionalLight([0, 0, 1]);
        await preloadDirectionalShadowBounds([mesh]);
        const absolute = computeDirectionalLightMatrix(light, [mesh], 1, 100);
        const relative = computeDirectionalLightMatrix(light, [mesh], 1, 100, 1000, 2000, 3000);
        for (const [x, y] of [
            [999, 2005],
            [1001, 2007],
        ]) {
            const absoluteX = absolute._viewProj[0]! * x! + absolute._viewProj[12]!;
            const absoluteY = absolute._viewProj[5]! * y! + absolute._viewProj[13]!;
            const relativeX = relative._viewProj[0]! * (x! - 1000) + relative._viewProj[12]!;
            const relativeY = relative._viewProj[5]! * (y! - 2000) + relative._viewProj[13]!;
            expect(relativeX).toBeCloseTo(absoluteX, 3);
            expect(relativeY).toBeCloseTo(absoluteY, 3);
        }
    });

    it("ignores parked instances and unused capacity, clamps count, and excludes an empty prototype", async () => {
        const mesh = instances(matrix(0.01), matrix(0, 1_000_000), matrix(1, 1_000_000));
        setThinInstanceCount(mesh, 2);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(0.5);
        setThinInstanceCount(mesh, 100);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(1_000_050);
        setThinInstanceCount(mesh, 0);
        expect(getThinInstanceWorldBounds(mesh)).toBeNull();

        const light = createDirectionalLight([0, 0, 1]);
        await preloadDirectionalShadowBounds([mesh]);
        expect(computeDirectionalLightMatrix(light, [mesh], 1, 100)._viewProj).toEqual(computeDirectionalLightMatrix(light, [], 1, 100)._viewProj);
        setThinInstanceCount(mesh, 2);
        setThinInstanceMatrix(mesh, 0, matrix(0));
        expect(getThinInstanceWorldBounds(mesh)).toBeNull();
    });

    it("reuses cached storage without rescanning and invalidates on matrix, count, transform and bounds changes", () => {
        const mesh = instances(matrix(0.01));
        const world = vi.spyOn(mesh, "worldMatrix", "get");
        const first = getThinInstanceWorldBounds(mesh)!;
        world.mockClear();
        expect(getThinInstanceWorldBounds(mesh)).toBe(first);
        expect(world).not.toHaveBeenCalled();

        setThinInstanceMatrix(mesh, 0, matrix(0.01, 2));
        expect(getThinInstanceWorldBounds(mesh)).toBe(first);
        expect(first.min[0]).toBeCloseTo(1.5);
        mesh.position.x = 10;
        expect(getThinInstanceWorldBounds(mesh)!.min[0]).toBeCloseTo(11.5);
        mesh.boundMin![0] = -100;
        expect(getThinInstanceWorldBounds(mesh)!.min[0]).toBeCloseTo(11);
        setThinInstances(mesh, new Float32Array(matrix(1)), 1);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(60);
        setThinInstanceCount(mesh, 0);
        expect(getThinInstanceWorldBounds(mesh)).toBeNull();
        setThinInstanceCount(mesh, 1);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(60);
        world.mockRestore();
    });

    it.each(["pcf", "esm"])("preloads instance bounds through the %s generator's task hook", async (kind) => {
        vi.resetModules();
        const engine = engineStub();
        const factory =
            kind === "pcf"
                ? (await import("../../../packages/babylon-lite/src/shadow/pcf-directional-shadow-generator")).createPcfDirectionalShadowGenerator
                : (await import("../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator")).createEsmDirectionalShadowGenerator;
        const light = createDirectionalLight([0, 0, 1]);
        const generator = factory(engine, light);
        const mesh = instances(matrix(0.01));

        await generator._preloadShadowTask!([mesh]);

        const { computeDirectionalLightMatrix: fit } = await import("../../../packages/babylon-lite/src/shadow/shadow-base");
        expect(2 / fit(light, [mesh], 1, 100)._viewProj[0]!).toBeCloseTo(1.2);
    });

    it.each([
        ["pcf", "set", false],
        ["pcf", "add", false],
        ["esm", "set", false],
        ["esm", "add", false],
        ["pcf", "set", true],
        ["pcf", "add", true],
        ["esm", "set", true],
        ["esm", "add", true],
    ])("defers %s fitting when a registered caster gains instances via %s (morph: %s)", async (kind, conversion, morph) => {
        vi.resetModules();
        const engine = engineStub();
        const factory =
            kind === "pcf"
                ? (await import("../../../packages/babylon-lite/src/shadow/pcf-directional-shadow-generator")).createPcfDirectionalShadowGenerator
                : (await import("../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator")).createEsmDirectionalShadowGenerator;
        const { createShadowTask } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-task");
        const { setShadowTaskCasterMeshes, _getShadowTaskCasterMeshes } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-inputs");
        const { createShadowCamera, createSharedShadowUBO } = await import("../../../packages/babylon-lite/src/shadow/shadow-base");
        const { addThinInstance } = await import("../../../packages/babylon-lite/src/mesh/thin-instance");
        const generator = factory(engine, createDirectionalLight([0, 0, 1]));
        const mesh = caster();
        const displacement = morph ? 200 : 0;
        if (morph) {
            mesh.morphTargets = {
                count: 1,
                weights: new Float32Array([1]),
                targets: [{ positions: new Float32Array([displacement, 0, 0]), normals: null }],
            } as unknown as MorphTargetData;
        }
        const casters = [mesh];
        const scene = { lights: [{ shadowGenerator: generator }], _renderableVersion: 1 } as unknown as SceneContext;
        const execute = vi.fn(() => 1);
        const state = {
            _task: { record: vi.fn(), execute, dispose: vi.fn() },
            _camera: createShadowCamera(generator),
            _casterMeshes: casters as readonly (typeof mesh)[],
            _scene: scene,
            _lastCasterVersion: -1,
            _lastLightVersion: -1,
            _lastFoVersion: -1,
            _shadowUboData: createSharedShadowUBO(engine, generator._lightMatrix, generator._depthValues, generator._shadowsInfo).data,
        };
        generator._ensureShadowTaskState = (_engine, _scene, meshes) => {
            state._casterMeshes = meshes;
            generator._shadowTaskState = state as unknown as ShadowTaskInternalState;
            return generator._shadowTaskState;
        };
        if (morph) {
            const { enableMorphTargetShadows } = await import("../../../packages/babylon-lite/src/shadow/enable-morph-target-shadows");
            enableMorphTargetShadows(generator);
        }
        const task = createShadowTask(engine, scene);
        setShadowTaskCasterMeshes(generator, casters);
        await task._preload!();
        task.record();
        expect(task.execute?.()).toBe(kind === "pcf" ? 1 : 3);
        const previousCasterVersion = state._lastCasterVersion;
        expect(2 / generator._lightMatrix[0]!).toBeCloseTo(120);
        execute.mockClear();

        if (conversion === "set") {
            setThinInstances(mesh, new Float32Array(matrix(0.01)), 1);
        } else {
            addThinInstance(mesh, matrix(0.01));
        }
        expect(task.execute?.()).toBe(0);
        expect(generator._preloadPending).toBe(casters);
        expect(state._lastCasterVersion).toBe(previousCasterVersion);
        expect(2 / generator._lightMatrix[0]!).toBeCloseTo(120);
        expect(execute).not.toHaveBeenCalled();
        expect(task.execute?.()).toBe(0);

        await vi.waitFor(() => expect(generator._preloadPending).toBeUndefined());
        expect(task.execute?.()).toBe(kind === "pcf" ? 1 : 3);
        expect(execute).toHaveBeenCalledOnce();
        expect(2 / generator._lightMatrix[0]!).toBeCloseTo(1.2);
        expect(generator._lightMatrix[0]! * displacement * 0.01 + generator._lightMatrix[12]!).toBeCloseTo(0);
        expect(_getShadowTaskCasterMeshes(generator)).toBe(casters);
        expect(state._casterMeshes).toBe(casters);
    });
});
