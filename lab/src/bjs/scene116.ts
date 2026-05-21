// Scene 116 (BJS reference harness): Standard + PBR meshes with two RTT previews.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Effect } from "@babylonjs/core/Materials/effect";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

Effect.ShadersStore["scene116DepthVertexShader"] = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore["scene116DepthFragmentShader"] = `
precision highp float;
void main(void) {
    gl_FragColor = vec4(vec3(gl_FragCoord.z), 1.0);
}`;

function createDepthPreviewTexture(scene: Scene, rtt: RenderTargetTexture, name: string): Texture {
    rtt.createDepthStencilTexture(0, false, false, 1, undefined, `${name}-depth`);
    const depthTexture = rtt.depthStencilTexture;
    if (!depthTexture) {
        throw new Error(`Scene 116: failed to create depth texture for ${name}.`);
    }
    return new Texture(null, scene, {
        noMipmap: true,
        invertY: false,
        samplingMode: Texture.NEAREST_SAMPLINGMODE,
        internalTexture: depthTexture,
        gammaSpace: false,
    });
}

function waitForRenderedFrames(scene: Scene, targets: readonly RenderTargetTexture[], frameCount: number): Promise<void> {
    const waitForScene = new Promise<void>((resolve) => {
        let remaining = frameCount;
        const observer = scene.onAfterRenderObservable.add(() => {
            remaining--;
            if (remaining <= 0) {
                scene.onAfterRenderObservable.remove(observer);
                resolve();
            }
        });
    });
    const waitForTargets = targets.map(
        (target) =>
            new Promise<void>((resolve) => {
                let remaining = frameCount;
                const observer = target.onAfterRenderObservable.add(() => {
                    remaining--;
                    if (remaining <= 0) {
                        target.onAfterRenderObservable.remove(observer);
                        resolve();
                    }
                });
            })
    );
    return Promise.all([waitForScene, ...waitForTargets]).then(() => undefined);
}

const READY_RENDERED_FRAMES = 50;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("mainCamera", -Math.PI / 2, Math.PI / 2.35, 8.5, new Vector3(0, -0.25, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 1;

    const standardMesh = MeshBuilder.CreateTorus("standard", { diameter: 1.6, thickness: 0.45, tessellation: 48 }, scene);
    standardMesh.position.x = -2.25;
    standardMesh.position.y = 1.0;
    const standardMaterial = new StandardMaterial("standardMaterial", scene);
    standardMaterial.diffuseColor = new Color3(0.25, 0.45, 1.0);
    standardMaterial.alpha = 1.0;
    standardMaterial.specularPower = 96;
    standardMesh.material = standardMaterial;

    const pbrMesh = MeshBuilder.CreateSphere("pbr", { segments: 32, diameter: 1.8 }, scene);
    pbrMesh.position.x = 2.25;
    pbrMesh.position.y = 1.0;
    const pbrMaterial = new PBRMaterial("pbrMaterial", scene);
    pbrMaterial.albedoColor = new Color3(1.0, 0.72, 0.22);
    pbrMaterial.metallic = 0;
    pbrMaterial.roughness = 0.7;
    pbrMaterial.environmentIntensity = 0;
    pbrMaterial.unlit = true;
    pbrMesh.material = pbrMaterial;

    const standardDepthMaterial = new ShaderMaterial("standardDepthMaterial", scene, "scene116Depth", { attributes: ["position"], uniforms: ["worldViewProjection"] }, false);
    const pbrDepthMaterial = new ShaderMaterial("pbrDepthMaterial", scene, "scene116Depth", { attributes: ["position"], uniforms: ["worldViewProjection"] }, false);

    const standardRTT = new RenderTargetTexture("standard-shadow-depth", { width: 512, height: 512 }, scene, false, true, undefined, false, Texture.NEAREST_SAMPLINGMODE);
    const standardDepthTexture = createDepthPreviewTexture(scene, standardRTT, "standard-shadow-depth");
    standardRTT.clearColor = new Color4(1, 1, 1, 1);
    const standardRTTCamera = new FreeCamera("standardRTTCamera", new Vector3(-2.25, 1.0, -4.0), scene);
    standardRTTCamera.minZ = 2;
    standardRTTCamera.maxZ = 8;
    standardRTTCamera.setTarget(new Vector3(-2.25, 1.0, 0));
    standardRTT.activeCamera = standardRTTCamera;
    standardRTT.renderList = [standardMesh];
    standardRTT.setMaterialForRendering(standardMesh, standardDepthMaterial);
    scene.customRenderTargets.push(standardRTT);

    const pbrRTT = new RenderTargetTexture("pbr-shadow-depth", { width: 512, height: 512 }, scene, false, true, undefined, false, Texture.NEAREST_SAMPLINGMODE);
    const pbrDepthTexture = createDepthPreviewTexture(scene, pbrRTT, "pbr-shadow-depth");
    pbrRTT.clearColor = new Color4(1, 1, 1, 1);
    const pbrRTTCamera = new FreeCamera("pbrRTTCamera", new Vector3(2.25, 1.0, -4.0), scene);
    pbrRTTCamera.minZ = 2;
    pbrRTTCamera.maxZ = 8;
    pbrRTTCamera.setTarget(new Vector3(2.25, 1.0, 0));
    pbrRTT.activeCamera = pbrRTTCamera;
    pbrRTT.renderList = [pbrMesh];
    pbrRTT.setMaterialForRendering(pbrMesh, pbrDepthMaterial);
    scene.customRenderTargets.push(pbrRTT);

    const standardPreview = MeshBuilder.CreatePlane("standardPreview", { width: 2.2, height: 2.2 }, scene);
    standardPreview.position.x = -2.25;
    standardPreview.position.y = -1.6;
    const standardPreviewMaterial = new StandardMaterial("standardPreviewMaterial", scene);
    standardPreviewMaterial.disableLighting = true;
    standardPreviewMaterial.diffuseColor = Color3.Black();
    standardPreviewMaterial.emissiveColor = Color3.Black();
    standardPreviewMaterial.emissiveTexture = standardDepthTexture;
    standardPreview.material = standardPreviewMaterial;

    const pbrPreview = MeshBuilder.CreatePlane("pbrPreview", { width: 2.2, height: 2.2 }, scene);
    pbrPreview.position.x = 2.25;
    pbrPreview.position.y = -1.6;
    const pbrPreviewMaterial = new StandardMaterial("pbrPreviewMaterial", scene);
    pbrPreviewMaterial.disableLighting = true;
    pbrPreviewMaterial.diffuseColor = Color3.Black();
    369900;
    pbrPreviewMaterial.emissiveColor = Color3.Black();
    pbrPreviewMaterial.emissiveTexture = pbrDepthTexture;
    pbrPreview.material = pbrPreviewMaterial;

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await waitForRenderedFrames(scene, [standardRTT, pbrRTT], READY_RENDERED_FRAMES);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
