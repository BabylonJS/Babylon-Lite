import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

interface PipelineInternals {
    _alphaToCoverageEnabled: boolean;
    _buildRenderPipelineDescriptor(effect: Effect, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
    setAlphaToCoverage(enabled: boolean): void;
}

// The lab currently pins an older Babylon.js package whose pipeline cache already tracks the A2C
// state/key but predates the descriptor assignment. Backport that one assignment for the golden.
const pipelinePrototype = WebGPUCacheRenderPipeline.prototype as unknown as PipelineInternals;
const buildRenderPipelineDescriptor = pipelinePrototype._buildRenderPipelineDescriptor;
pipelinePrototype._buildRenderPipelineDescriptor = function (effect: Effect, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor {
    const descriptor = buildRenderPipelineDescriptor.call(this, effect, topology, sampleCount);
    descriptor.multisample!.alphaToCoverageEnabled = this._alphaToCoverageEnabled && sampleCount > 1;
    return descriptor;
};

Effect.ShadersStore["scene268VertexShader"] = `
precision highp float;
attribute vec3 position;
uniform vec2 center;
uniform float angle;
uniform float depth;
void main(void) {
    float c = cos(angle);
    float s = sin(angle);
    vec2 local = position.xy * 1.65;
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    vec2 world = center + rotated;
    gl_Position = vec4(world.x / 3.3, world.y / 2.2, depth, 1.0);
}`;

Effect.ShadersStore["scene268FragmentShader"] = `
precision highp float;
uniform vec3 color;
uniform float opacity;
void main(void) {
    gl_FragColor = vec4(color, opacity);
}`;

const RED = new Color3(0.95, 0.12, 0.16);
const GREEN = new Color3(0.1, 0.85, 0.32);
const ROWS = [
    { y: 0.85, redInFront: true, redRotation: -0.08, greenRotation: 0.1 },
    { y: -0.85, redInFront: false, redRotation: 0.1, greenRotation: -0.07 },
] as const;

function createCardMaterial(scene: Scene, center: Vector2, rotation: number, depth: number, color: Color3, opacity: number): ShaderMaterial {
    const material = new ShaderMaterial(
        "a2c-card",
        scene,
        { vertex: "scene268", fragment: "scene268" },
        { attributes: ["position"], uniforms: ["center", "angle", "depth", "color", "opacity"] }
    );
    material.backFaceCulling = false;
    material.forceDepthWrite = true;
    material.setVector2("center", center);
    material.setFloat("angle", rotation);
    material.setFloat("depth", depth);
    material.setColor3("color", color);
    material.setFloat("opacity", opacity);
    return material;
}

function addPanel(scene: Scene, x: number, renderingGroupId: number): void {
    let alphaIndex = 0;
    for (const row of ROWS) {
        const redFront = row.redInFront;
        const red = MeshBuilder.CreatePlane("red-card", { size: 1 }, scene);
        red.material = createCardMaterial(scene, new Vector2(x - 0.08, row.y - 0.04), row.redRotation, redFront ? 0.6 : 0.4, RED, redFront ? 0.5 : 1);
        red.renderingGroupId = renderingGroupId;
        red.alphaIndex = alphaIndex++;

        const green = MeshBuilder.CreatePlane("green-card", { size: 1 }, scene);
        green.material = createCardMaterial(scene, new Vector2(x + 0.08, row.y + 0.04), row.greenRotation, redFront ? 0.4 : 0.6, GREEN, redFront ? 1 : 0.5);
        green.renderingGroupId = renderingGroupId;
        green.alphaIndex = alphaIndex++;
    }
}

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, premultipliedAlpha: false });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.035, 0.045, 0.07, 1);
    scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);

    addPanel(scene, -1.65, 0);
    addPanel(scene, 1.65, 1);

    const pipelineCache = engine._cacheRenderPipeline as unknown as PipelineInternals;
    let previousAlphaToCoverage = false;
    scene.onBeforeRenderingGroupObservable.add((info) => {
        previousAlphaToCoverage = pipelineCache._alphaToCoverageEnabled;
        pipelineCache.setAlphaToCoverage(info.renderingGroupId === 1 && engine.currentSampleCount > 1);
    });
    scene.onAfterRenderingGroupObservable.add(() => {
        pipelineCache.setAlphaToCoverage(previousAlphaToCoverage);
    });

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.sampleCount = String(engine.currentSampleCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
