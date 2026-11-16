import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstanceCount, setThinInstanceMatrix, setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { computeDirectionalLightMatrix, preloadDirectionalShadowBounds } from "../../../packages/babylon-lite/src/shadow/shadow-base";
import { getThinInstanceWorldBounds } from "../../../packages/babylon-lite/src/shadow/thin-instance-shadow-bounds";

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

describe("directional thin-instance shadow bounds", () => {
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
        ["pcf", "set"],
        ["pcf", "add"],
        ["esm", "set"],
        ["esm", "add"],
    ])("defers %s fitting when an ordinary registered caster gains instances via %s", async (kind, conversion) => {
        vi.resetModules();
        const engine = engineStub();
        const factory =
            kind === "pcf"
                ? (await import("../../../packages/babylon-lite/src/shadow/pcf-directional-shadow-generator")).createPcfDirectionalShadowGenerator
                : (await import("../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator")).createEsmDirectionalShadowGenerator;
        const { createShadowTask } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-task");
        const { setShadowTaskCasterMeshes } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-inputs");
        const { createShadowCamera } = await import("../../../packages/babylon-lite/src/shadow/shadow-base");
        const { addThinInstance } = await import("../../../packages/babylon-lite/src/mesh/thin-instance");
        const generator = factory(engine, createDirectionalLight([0, 0, 1]));
        const mesh = caster();
        const casters = [mesh];
        const scene = { lights: [{ shadowGenerator: generator }], _renderableVersion: 1 } as unknown as SceneContext;
        const execute = vi.fn(() => 1);
        const state = {
            _task: { record: vi.fn(), execute, dispose: vi.fn() },
            _camera: createShadowCamera(generator),
            _casterMeshes: casters,
            _scene: scene,
            _lastCasterVersion: -1,
            _lastLightVersion: -1,
            _lastFoVersion: -1,
            _shadowUboData: new Float32Array(24),
        };
        generator._ensureShadowTaskState = () => state as unknown as ShadowTaskInternalState;
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
    });
});
