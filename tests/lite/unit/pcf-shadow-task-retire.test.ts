import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { ensurePcfShadowTaskState, type PcfTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

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

describe("ensurePcfShadowTaskState", () => {
    it("retires the superseded task behind the frame fence instead of disposing it synchronously", () => {
        const engine = {} as EngineContext;
        const dispose = vi.fn();
        const oldCasters: Mesh[] = [];
        const existing = { _casterMeshes: oldCasters, _task: { dispose } } as unknown as PcfTaskState;

        const next = ensurePcfShadowTaskState(engine, {} as SceneContext, {} as ShadowGenerator, [], existing);

        expect(next).not.toBe(existing);
        expect(dispose).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);
        engine._retirements![0]!();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("keeps the state and retires nothing when the caster set is unchanged", () => {
        const engine = {} as EngineContext;
        const casters: Mesh[] = [];
        const existing = { _casterMeshes: casters, _task: { dispose: vi.fn() } } as unknown as PcfTaskState;

        expect(ensurePcfShadowTaskState(engine, {} as SceneContext, {} as ShadowGenerator, casters, existing)).toBe(existing);
        expect(engine._retirements ?? []).toHaveLength(0);
    });
});
