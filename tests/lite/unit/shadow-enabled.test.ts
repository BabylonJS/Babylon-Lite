import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { setShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import { createShadowTask } from "../../../packages/babylon-lite/src/frame-graph/shadow-task";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { setShadowGeneratorEnabled } from "../../../packages/babylon-lite/src/shadow/shadow-enabled";
import type { ShadowGenerator, ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

function createFixture(type: ShadowGenerator["_shadowType"]) {
    const writeBuffer = vi.fn();
    const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
    const casters = [{} as Mesh];
    const taskState = {
        _task: { record: vi.fn(), execute: vi.fn(), dispose: vi.fn() },
        _casterMeshes: casters,
        ...(type === "csm" ? { _uboData: new Float32Array(80) } : {}),
    } as unknown as ShadowTaskInternalState;
    const renderShadowMap = vi.fn(() => 2);
    const generator = {
        _shadowType: type,
        _shadowUBO: {} as GPUBuffer,
        _shadowsInfo: new Float32Array([0.3, 0, 0, 0]),
        _version: 0,
        _ensureShadowTaskState: () => taskState,
        _renderShadowMap: renderShadowMap,
    } as unknown as ShadowGenerator;
    setShadowTaskCasterMeshes(generator, casters);
    generator._preloadPending = undefined;
    const scene = { lights: [{ shadowGenerator: generator }], _renderableVersion: 0 } as unknown as SceneContext;
    const task = createShadowTask(engine, scene);
    return { engine, generator, task, taskState, renderShadowMap, writeBuffer };
}

describe("runtime shadow enablement", () => {
    it("updates ordinary receiver darkness once per transition and skips disabled rendering", () => {
        const { generator, task, renderShadowMap, writeBuffer } = createFixture("pcf");
        setShadowGeneratorEnabled(generator, true);

        expect(task.execute!()).toBe(2);
        expect(writeBuffer).toHaveBeenLastCalledWith(generator._shadowUBO, 80, expect.any(Float32Array));

        setShadowGeneratorEnabled(generator, false);
        expect(task.execute!()).toBe(0);
        expect(Array.from(writeBuffer.mock.calls.at(-1)![2] as Float32Array)).toEqual([1]);
        const writesWhileDisabled = writeBuffer.mock.calls.length;
        expect(task.execute!()).toBe(0);
        expect(writeBuffer).toHaveBeenCalledTimes(writesWhileDisabled);
        generator._shadowUBO = {} as GPUBuffer;
        expect(task.execute!()).toBe(0);
        expect(writeBuffer).toHaveBeenCalledTimes(writesWhileDisabled + 1);

        setShadowGeneratorEnabled(generator, true);
        expect(task.execute!()).toBe(2);
        expect((writeBuffer.mock.calls.at(-1)![2] as Float32Array)[0]).toBeCloseTo(0.3);
        expect(renderShadowMap).toHaveBeenCalledTimes(2);
    });

    it("updates CSM receiver data, callbacks, and the CSM darkness offset", () => {
        const { generator, task, taskState, writeBuffer } = createFixture("csm");
        const receiverUpdate = vi.fn();
        generator._onReceiverData = [receiverUpdate];
        setShadowGeneratorEnabled(generator, false);

        expect(task.execute!()).toBe(0);
        expect(writeBuffer).toHaveBeenLastCalledWith(generator._shadowUBO, 288, expect.any(Float32Array));
        expect((taskState as ShadowTaskInternalState & { _uboData: Float32Array })._uboData[72]).toBe(1);
        expect(receiverUpdate).toHaveBeenLastCalledWith((taskState as ShadowTaskInternalState & { _uboData: Float32Array })._uboData);
    });

    it("preserves later shadow render-hook replacements", () => {
        const { generator, task } = createFixture("pcf");
        setShadowGeneratorEnabled(generator, true);
        const replacement = vi.fn(() => 3);
        generator._renderShadowMap = replacement;

        expect(task.execute!()).toBe(3);
        expect(replacement).toHaveBeenCalledOnce();
    });
});
