import { beforeEach, describe, expect, it, vi } from "vitest";

const { attach, detach, dispose, createSceneSsaoPipeline } = vi.hoisted(() => {
    const attach = vi.fn();
    const detach = vi.fn();
    const dispose = vi.fn();
    return {
        attach,
        detach,
        dispose,
        createSceneSsaoPipeline: vi.fn(() => ({
            camera: null,
            radius: 0,
            intensity: 0,
            base: 0,
            fadeEnd: 0,
            attached: false,
        })),
    };
});

vi.mock("babylon-lite", () => ({
    createSceneSsaoPipeline,
    attachSceneSsaoPipeline: attach,
    detachSceneSsaoPipeline: detach,
    disposeSceneSsaoPipeline: dispose,
}));

import { PostProcessRenderPipelineManager } from "../src/post-processes/post-process-render-pipeline-manager";
import { SSAO2RenderingPipeline } from "../src/post-processes/ssao2-rendering-pipeline";
import { Scene } from "../src/scene/scene";
import type { Camera } from "../src/cameras/cameras";

function makeScene(headless = false) {
    const manager = new PostProcessRenderPipelineManager();
    const engine = { _headless: headless, _lite: {} };
    return {
        _lite: { camera: null },
        postProcessRenderPipelineManager: manager,
        getEngine: () => engine,
    } as unknown as Scene;
}

describe("SSAO2RenderingPipeline", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("registers, attaches, and forwards supported settings to the native pipeline", () => {
        const scene = makeScene();
        const camera = { _lite: {} } as Camera;
        const pipeline = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.75, blurRatio: 0.75 }, [camera]);

        expect(scene.postProcessRenderPipelineManager.supportedPipelines).toEqual([pipeline]);
        expect(createSceneSsaoPipeline).toHaveBeenCalledWith(
            expect.objectContaining({ name: "ssao", resolutionScale: 0.75, radius: 2, intensity: 1, base: 0, fadeEnd: 100 }),
            {},
            scene._lite,
            camera._lite
        );
        const native = createSceneSsaoPipeline.mock.results[0]!.value;
        expect(attach).toHaveBeenCalledWith(native, camera._lite);

        pipeline.radius = 0.09;
        pipeline.totalStrength = 0.9;
        pipeline.base = 0.5;
        pipeline.maxZ = 11;
        pipeline.bypassBlur = true;
        pipeline.bilateralSamples = 8;
        pipeline.bilateralSoften = 0.25;
        pipeline.bilateralTolerance = 0.5;
        pipeline.useViewportInCombineStage = false;
        expect(native).toMatchObject({ radius: 0.09, intensity: 0.9, base: 0.5, fadeEnd: 11 });
        expect(pipeline.scene).toBe(scene);
        expect(pipeline.name).toBe("ssao");
        expect(pipeline.engine).toBe(scene.getEngine());
        expect(pipeline.cameras).toEqual([camera]);
        expect(pipeline.uniqueId).toBeGreaterThan(0);
        expect(pipeline.isReady()).toBe(true);
        expect(pipeline.serialize()).toMatchObject({
            customType: "SSAO2RenderingPipeline",
            _name: "ssao",
            bypassBlur: true,
            bilateralSamples: 8,
            bilateralSoften: 0.25,
            bilateralTolerance: 0.5,
        });

        scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline("ssao", camera);
        scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline("ssao", camera);
        expect(detach).toHaveBeenCalledWith(native, camera._lite);
        expect(attach).toHaveBeenCalledTimes(2);

        pipeline.dispose();
        expect(dispose).toHaveBeenCalledWith(native);
        expect(scene.postProcessRenderPipelineManager.supportedPipelines).toEqual([]);
    });

    it("forwards manager update/rebuild and explicitly rejects independent effect toggles", () => {
        const scene = makeScene();
        const camera = { _lite: {} } as Camera;
        const pipeline = new SSAO2RenderingPipeline("ssao", scene, 1, [camera]);
        const update = vi.spyOn(pipeline, "_update");
        const rebuild = vi.spyOn(pipeline, "_rebuild");

        scene.postProcessRenderPipelineManager.update();
        scene.postProcessRenderPipelineManager._rebuild();

        expect(update).toHaveBeenCalledOnce();
        expect(rebuild).toHaveBeenCalledOnce();
        expect(() => scene.postProcessRenderPipelineManager.enableEffectInPipeline("ssao", "effect", camera)).toThrow(/independently toggleable/);
        expect(() => scene.postProcessRenderPipelineManager.disableEffectInPipeline("ssao", "effect", camera)).toThrow(/independently toggleable/);
    });

    it("keeps the Scene manager lazy and stable before pipeline construction", () => {
        const scene = Object.create(Scene.prototype) as Scene;
        Object.defineProperty(scene, "_postProcessRenderPipelineManager", { value: null, writable: true });

        expect(scene.postProcessRenderPipelineManager).toBe(scene.postProcessRenderPipelineManager);
    });

    it("creates an inert registered pipeline for a headless scene", () => {
        const scene = makeScene(true);
        const camera = { _lite: {} } as Camera;
        const pipeline = new SSAO2RenderingPipeline("ssao", scene, 1, [camera]);

        expect(createSceneSsaoPipeline).not.toHaveBeenCalled();
        expect(pipeline.isSupported).toBe(false);
        expect(scene.postProcessRenderPipelineManager.supportedPipelines).toEqual([]);
    });
});
