import { FontAsset, TextRenderer } from "@babylonjs/addons/msdfText/index.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import type { Effect } from "@babylonjs/core/Materials/effect";

interface PipelineInternals {
    _alphaToCoverageEnabled: boolean;
    _buildRenderPipelineDescriptor(effect: Effect, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
    setAlphaToCoverage(enabled: boolean): void;
}

interface EngineInternals {
    _cacheRenderPipeline: PipelineInternals;
    getAlphaToCoverage(): boolean;
    setAlphaToCoverage(enabled: boolean): void;
}

// The pinned core tracks A2C in its cache key but predates assigning the state to the descriptor.
const pipelinePrototype = WebGPUCacheRenderPipeline.prototype as unknown as PipelineInternals;
const buildRenderPipelineDescriptor = pipelinePrototype._buildRenderPipelineDescriptor;
pipelinePrototype._buildRenderPipelineDescriptor = function (effect: Effect, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor {
    const descriptor = buildRenderPipelineDescriptor.call(this, effect, topology, sampleCount);
    descriptor.multisample!.alphaToCoverageEnabled = this._alphaToCoverageEnabled && sampleCount > 1;
    return descriptor;
};

async function createText(engine: WebGPUEngine, font: FontAsset, color: Color4, z: number): Promise<TextRenderer> {
    const text = await TextRenderer.CreateTextRendererAsync(font, engine);
    text.color = color;
    text.writeToDepthBuffer = true;
    text.addParagraph("A2C");
    text.transformMatrix = Matrix.Compose(new Vector3(2.14, 2.14, 1), Quaternion.Identity(), new Vector3(-0.06, 0.73, z));
    return text;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, premultipliedAlpha: false });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const engineInternals = engine as unknown as EngineInternals;
    engineInternals.getAlphaToCoverage = () => engineInternals._cacheRenderPipeline._alphaToCoverageEnabled;
    engineInternals.setAlphaToCoverage = (enabled) => engineInternals._cacheRenderPipeline.setAlphaToCoverage(enabled);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.035, 0.045, 0.07, 1);
    const camera = (scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -10), scene));
    camera.setTarget(Vector3.Zero());

    const fontDefinition = await (await fetch("https://assets.babylonjs.com/fonts/roboto-regular.json")).text();
    const font = new FontAsset(fontDefinition, "https://assets.babylonjs.com/fonts/roboto-regular.png", scene);
    const front = await createText(engine, font, new Color4(242 / 255, 31 / 255, 41 / 255, 1), 0);
    const rear = await createText(engine, font, new Color4(26 / 255, 217 / 255, 83 / 255, 1), 0.2);

    scene.onAfterRenderObservable.add(() => {
        front.render(camera.getViewMatrix(), camera.getProjectionMatrix());
        rear.render(camera.getViewMatrix(), camera.getProjectionMatrix());
    });

    await scene.whenReadyAsync();
    let frames = 0;
    engine.runRenderLoop(() => {
        scene.render();
        if (++frames === 10) {
            canvas.dataset.sampleCount = String(engine.currentSampleCount);
            canvas.dataset.ready = "true";
        }
    });
}

void main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
