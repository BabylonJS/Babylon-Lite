import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { ensureEsmShadowTaskState, setEsmShadowTaskResources, type EsmShadowTaskResources } from "../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator";
import { ensurePcfShadowTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { ShadowGenerator, ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", () => ({
    createShadowCamera: () => ({}),
    createShadowRenderTarget: () => ({}),
    casterVersionSum: () => 0,
    updateShadowCameraBase: () => undefined,
    writeShadowUboFields: () => undefined,
}));

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: () => ({ addMesh: vi.fn(), dispose: vi.fn() }),
}));

type EnsureState = (engine: EngineContext, scene: SceneContext, sg: ShadowGenerator, casterMeshes: readonly Mesh[], existing: ShadowTaskInternalState | null) => unknown;

function makeEsmGenerator(): ShadowGenerator {
    const sg = { _shadowParamsUBO: {} } as unknown as ShadowGenerator;
    setEsmShadowTaskResources(sg, { _esmTexture: {}, _depthBuffer: {} } as unknown as EsmShadowTaskResources);
    return sg;
}

// Every supported generator reaches its state builder through the same `setShadowTaskCasterMeshes()` re-supply
// path, so the old task must be retired behind the frame fence in each of them, not only in PCF.
describe.each<[string, EnsureState, () => ShadowGenerator]>([
    ["PCF", ensurePcfShadowTaskState as EnsureState, () => ({}) as ShadowGenerator],
    ["ESM", ensureEsmShadowTaskState as EnsureState, makeEsmGenerator],
])("%s shadow task state", (_name, ensureState, makeGenerator) => {
    it("retires the superseded task behind the frame fence instead of disposing it synchronously", () => {
        const engine = {} as EngineContext;
        const dispose = vi.fn();
        const existing = { _casterMeshes: [] as Mesh[], _task: { dispose } } as unknown as ShadowTaskInternalState;

        const next = ensureState(engine, {} as SceneContext, makeGenerator(), [], existing);

        expect(next).not.toBe(existing);
        expect(dispose).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);
        engine._retirements![0]!();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("keeps the state and retires nothing when the caster set is unchanged", () => {
        const engine = {} as EngineContext;
        const casters: Mesh[] = [];
        const existing = { _casterMeshes: casters, _task: { dispose: vi.fn() } } as unknown as ShadowTaskInternalState;

        expect(ensureState(engine, {} as SceneContext, makeGenerator(), casters, existing)).toBe(existing);
        expect(engine._retirements ?? []).toHaveLength(0);
    });
});
