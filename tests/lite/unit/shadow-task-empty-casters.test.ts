import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTaskConfig } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { ensureCsmShadowTaskState, type CsmConfig } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";
import { ensureEsmShadowTaskState, setEsmShadowTaskResources, type EsmShadowTaskResources } from "../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator";
import { ensurePcfShadowTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

const { taskConfigs } = vi.hoisted(() => ({ taskConfigs: [] as RenderTaskConfig[] }));

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/shadow/shadow-base")>()),
    createShadowCamera: () => ({}),
    createShadowRenderTarget: () => ({}),
}));

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/frame-graph/render-task")>()),
    createRenderTask: (config: RenderTaskConfig) => {
        taskConfigs.push(config);
        return { addMesh: vi.fn(), record: vi.fn(), dispose: vi.fn() };
    },
}));

const engine = {} as EngineContext;
const scene = { _renderableVersion: 1, _materialEpoch: 1 } as SceneContext;

// A render task whose render list is empty at record() time mirrors the WHOLE scene unless it opted out
// (`autoMirror: false`). For a shadow task that list is the caster set, so an empty set would draw every scene
// mesh into the shadow map — including the receivers that sample that very map, which WebGPU rejects
// ("usage (TextureBinding|RenderAttachment) … in the same synchronization scope") on every frame.
describe("shadow tasks with an empty caster set", () => {
    beforeEach(() => {
        taskConfigs.length = 0;
    });

    it("PCF never mirrors the scene into the shadow map", () => {
        ensurePcfShadowTaskState(engine, scene, {} as ShadowGenerator, [], null);

        expect(taskConfigs).toHaveLength(1);
        expect(taskConfigs[0]!.autoMirror).toBe(false);
    });

    it("ESM never mirrors the scene into the shadow map", () => {
        const sg = { _shadowParamsUBO: {} } as unknown as ShadowGenerator;
        setEsmShadowTaskResources(sg, { _esmTexture: {}, _depthBuffer: {} } as unknown as EsmShadowTaskResources);

        ensureEsmShadowTaskState(engine, scene, sg, [], null);

        expect(taskConfigs).toHaveLength(1);
        expect(taskConfigs[0]!.autoMirror).toBe(false);
    });

    it("CSM never mirrors the scene into any cascade layer", () => {
        const sg = { _depthTexture: { createView: () => ({}) } } as unknown as ShadowGenerator;
        const cfg = { _numCascades: 3, _mapSize: 1024 } as CsmConfig;

        ensureCsmShadowTaskState(engine, scene, sg, cfg, [], null);

        expect(taskConfigs).toHaveLength(3);
        expect(taskConfigs.every((config) => config.autoMirror === false)).toBe(true);
    });
});
