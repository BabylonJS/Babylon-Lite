declare module "ssao-comparison-baseline" {
    import type { Camera, EngineContext, RenderTarget, SceneContext, Task } from "babylon-lite";
    export interface BaselineAoTask extends Task {
        readonly depthTexture: RenderTarget;
        readonly occlusionTexture: RenderTarget;
        enabled: boolean;
        radius: number;
        intensity: number;
        temporalWeight: number;
        resetVersion: number;
        sliceCount: number;
        stepCount: number;
        bias: number;
        power: number;
    }
    export function createScreenSpaceAmbientOcclusionPostProcessTask(
        config: {
            name: string;
            sourceTexture: RenderTarget;
            depthTexture: RenderTarget;
            camera: Camera;
            composition: "none";
            resolutionScale: number;
            radius: number;
            temporalSamples: number;
            temporalWeight: number;
        },
        engine: EngineContext,
        scene: SceneContext
    ): BaselineAoTask;
}
