import type { EngineContext } from "../engine/engine.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

export interface PostProcessVec2 {
    x: number;
    y: number;
}

export interface ChromaticAberrationPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    aberrationAmount?: number;
    direction?: PostProcessVec2;
    radialIntensity?: number;
    centerPosition?: PostProcessVec2;
}

export interface ChromaticAberrationPostProcessTask extends PostProcessTask {
    aberrationAmount: number;
    direction: PostProcessVec2;
    radialIntensity: number;
    centerPosition: PostProcessVec2;
}

const CHROMATIC_ABERRATION_UNIFORM_WGSL = `struct ChromaticAberrationParams{chromatic_aberration:f32,screen_width:f32,screen_height:f32,radialIntensity:f32,direction:vec2f,centerPosition:vec2f}
@group(0) @binding(2) var<uniform> chromaticAberrationParams:ChromaticAberrationParams;`;

const CHROMATIC_ABERRATION_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let centered=uv-chromaticAberrationParams.centerPosition;var dir=chromaticAberrationParams.direction;if(dir.x==0.0&&dir.y==0.0){dir=normalize(centered);}let radius=sqrt(dot(centered,centered));let amount=chromaticAberrationParams.chromatic_aberration*pow(radius,chromaticAberrationParams.radialIntensity);let shift=amount*dir/vec2f(chromaticAberrationParams.screen_width,chromaticAberrationParams.screen_height);let r=samplePostProcessSource(vec2f(uv.x+shift.x*-0.3,uv.y+shift.y*-0.3*0.5));let g=samplePostProcessSource(uv);let b=samplePostProcessSource(vec2f(uv.x+shift.x*0.3,uv.y+shift.y*0.3*0.5));return vec4f(r.r,g.g,b.b,clamp(r.a+g.a+b.a,0,1));}`;

export function createChromaticAberrationPostProcessTask(
    config: ChromaticAberrationPostProcessTaskConfig,
    engine: EngineContext,
    scene: SceneContext
): ChromaticAberrationPostProcessTask {
    const params = {
        aberrationAmount: config.aberrationAmount ?? 30,
        screenWidth: 1,
        screenHeight: 1,
        direction: config.direction ?? { x: 0.707, y: 0.707 },
        radialIntensity: config.radialIntensity ?? 0,
        centerPosition: config.centerPosition ?? { x: 0.5, y: 0.5 },
    };
    const task = createPostProcessTask(
        {
            name: config.name ?? "chromatic-aberration",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode,
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                uniformWGSL: CHROMATIC_ABERRATION_UNIFORM_WGSL,
                uniformByteLength: 32,
                writeUniforms(data) {
                    data[0] = params.aberrationAmount;
                    data[1] = params.screenWidth;
                    data[2] = params.screenHeight;
                    data[3] = params.radialIntensity;
                    data[4] = params.direction.x;
                    data[5] = params.direction.y;
                    data[6] = params.centerPosition.x;
                    data[7] = params.centerPosition.y;
                },
                fragmentWGSL: CHROMATIC_ABERRATION_FRAGMENT_WGSL,
            },
        },
        engine,
        scene
    ) as ChromaticAberrationPostProcessTask;
    const record = task.record;
    task.record = () => {
        params.screenWidth = task.sourceTexture._width;
        params.screenHeight = task.sourceTexture._height;
        record();
    };
    Object.defineProperties(task, {
        aberrationAmount: {
            get: () => params.aberrationAmount,
            set: (value: number) => {
                params.aberrationAmount = value;
            },
        },
        direction: {
            get: () => params.direction,
            set: (value: PostProcessVec2) => {
                params.direction = value;
            },
        },
        radialIntensity: {
            get: () => params.radialIntensity,
            set: (value: number) => {
                params.radialIntensity = value;
            },
        },
        centerPosition: {
            get: () => params.centerPosition,
            set: (value: PostProcessVec2) => {
                params.centerPosition = value;
            },
        },
    });
    return task;
}
