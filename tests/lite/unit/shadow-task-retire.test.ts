import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { ensureEsmShadowTaskState, setEsmShadowTaskResources, type EsmShadowTaskResources } from "../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator";
import type { ShadowGenerator, ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", () => ({
    createShadowCamera: () => ({}),
    createShadowRenderTarget: () => ({}),
    casterVersionSum: () => 0,
    updateShadowCameraBase: () => undefined,
    writeShadowUboFields: () => undefined,
}));

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: () => ({ dispose: vi.fn() }),
    addMeshToTask: vi.fn(),
}));

function makeEsmGenerator(): ShadowGenerator {
    const sg = { _shadowParamsUBO: {} } as unknown as ShadowGenerator;
    setEsmShadowTaskResources(sg, { _esmTexture: {}, _depthBuffer: {} } as unknown as EsmShadowTaskResources);
    return sg;
}

// ESM still rebuilds on caster re-supply; PCF target replacement and incremental packet retirement are covered
// in pcf-caster-reconcile.test.ts.
describe("ESM shadow task state", () => {
    it("retires the superseded task behind the frame fence instead of disposing it synchronously", () => {
        const engine = {} as EngineContext;
        const dispose = vi.fn();
        const existing = { _casterMeshes: [] as Mesh[], _task: { dispose } } as unknown as ShadowTaskInternalState;

        const next = ensureEsmShadowTaskState(engine, {} as SceneContext, makeEsmGenerator(), [], existing);

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

        expect(ensureEsmShadowTaskState(engine, {} as SceneContext, makeEsmGenerator(), casters, existing)).toBe(existing);
        expect(engine._retirements ?? []).toHaveLength(0);
    });
});
