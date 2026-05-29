import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { AnaglyphPostProcess } from "@babylonjs/core/PostProcesses/anaglyphPostProcess";
import { BlackAndWhitePostProcess } from "@babylonjs/core/PostProcesses/blackAndWhitePostProcess";
import { BlurPostProcess } from "@babylonjs/core/PostProcesses/blurPostProcess";
import { ChromaticAberrationPostProcess } from "@babylonjs/core/PostProcesses/chromaticAberrationPostProcess";
import { PassPostProcess } from "@babylonjs/core/PostProcesses/passPostProcess";
import { Scene } from "@babylonjs/core/scene";

const BASE_ALPHA = -Math.PI / 2;
const BASE_BETA = Math.PI / 2.45;
const BASE_RADIUS = 2.2;
const BASE_TARGET = new Vector3(0, 0.25, 0);

function createCamera(name: string, scene: Scene, alpha = BASE_ALPHA): ArcRotateCamera {
    const camera = new ArcRotateCamera(name, alpha, BASE_BETA, BASE_RADIUS, BASE_TARGET.clone(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    return camera;
}

function createSourceTarget(name: string, scene: Scene, camera: ArcRotateCamera, meshes: AbstractMesh[]): RenderTargetTexture {
    const engine = scene.getEngine();
    const target = new RenderTargetTexture(name, { width: engine.getRenderWidth(), height: engine.getRenderHeight() }, scene, {
        generateDepthBuffer: true,
        generateStencilBuffer: true,
        samplingMode: Texture.BILINEAR_SAMPLINGMODE,
    });
    target.activeCamera = camera;
    target.renderList = meshes;
    target.clearColor = scene.clearColor;
    scene.customRenderTargets.push(target);
    return target;
}

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.12, 0.23, 0.42, 1);

    const sourceCamera = createCamera("source-camera", scene);
    const leftCamera = createCamera("left-camera", scene, BASE_ALPHA - 0.035);

    scene.activeCamera = sourceCamera;
    sourceCamera.attachControl(canvas, true);
    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.4;

    const colors = [new Color3(1, 0.12, 0.05), new Color3(0.05, 0.85, 0.16), new Color3(0.15, 0.32, 1)];
    const positions = [-1.55, 0, 1.55];
    const boxes: AbstractMesh[] = [];
    for (let i = 0; i < 3; i++) {
        const box = MeshBuilder.CreateBox(`box${i}`, { size: 1.15 }, scene);
        box.position = new Vector3(positions[i]!, 0, 0);
        box.rotation.y = 0.55;
        box.rotation.x = -0.25;
        const material = new StandardMaterial(`mat${i}`, scene);
        material.diffuseColor = colors[i]!;
        material.specularColor = new Color3(0, 0, 0);
        box.material = material;
        boxes.push(box);
    }

    const sourceTarget = createSourceTarget("scene142-source", scene, sourceCamera, boxes);
    const leftTarget = createSourceTarget("scene142-left", scene, leftCamera, boxes);

    const blackAndWhite = new BlackAndWhitePostProcess("scene142-black-and-white", 1, null, Texture.BILINEAR_SAMPLINGMODE, engine);
    blackAndWhite.degree = 1;
    const blur = new BlurPostProcess("scene142-blur", new Vector2(1, 1), 128, 1, null, Texture.BILINEAR_SAMPLINGMODE, engine);
    const chromatic = new ChromaticAberrationPostProcess(
        "scene142-chromatic-aberration",
        engine.getRenderWidth(),
        engine.getRenderHeight(),
        1,
        null,
        Texture.BILINEAR_SAMPLINGMODE,
        engine
    );
    chromatic.aberrationAmount = 70;
    chromatic.radialIntensity = 0;
    chromatic.direction = new Vector2(0.707, 0.707);
    chromatic.centerPosition = new Vector2(0.5, 0.5);
    const leftPass = new PassPostProcess("scene142-left-pass", 1, null, Texture.BILINEAR_SAMPLINGMODE, engine);
    const blurPass = new PassPostProcess("scene142-blur-pass", 1, null, Texture.BILINEAR_SAMPLINGMODE, engine);

    const sourceWrapper = sourceTarget.renderTarget;
    const leftWrapper = leftTarget.renderTarget;
    if (!sourceWrapper || !leftWrapper) {
        throw new Error("Scene 142 render targets were not allocated.");
    }
    blackAndWhite.inputTexture = sourceWrapper;
    blurPass.inputTexture = sourceWrapper;
    chromatic.inputTexture = sourceWrapper;
    leftPass.inputTexture = leftWrapper;
    leftCamera._rigPostProcess = leftPass;
    const anaglyph = new AnaglyphPostProcess("scene142-anaglyph", 1, [leftCamera, sourceCamera], Texture.BILINEAR_SAMPLINGMODE, engine);
    anaglyph.inputTexture = sourceWrapper;

    const quadrants: readonly [Viewport, readonly (typeof blackAndWhite)[]][] = [
        [new Viewport(0, 0.5, 0.5, 0.5), [blackAndWhite]],
        [new Viewport(0.5, 0.5, 0.5, 0.5), [anaglyph]],
        [new Viewport(0, 0, 0.5, 0.5), [blurPass, blur]],
        [new Viewport(0.5, 0, 0.5, 0.5), [chromatic]],
    ];

    function renderPostProcesses(): void {
        engine.restoreDefaultFramebuffer();
        engine.clear(scene.clearColor, true, true, true);
        for (const [viewport, postProcesses] of quadrants) {
            engine.setViewport(viewport);
            (engine as unknown as { _viewportsCurrent: { x: number } })._viewportsCurrent.x = -1;
            scene.postProcessManager.directRender(postProcesses, null, false, 0, 0, false);
        }
    }

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    let sourceTargetsRendered = false;
    scene.onAfterRenderObservable.add(() => {
        if (!sourceTargetsRendered) {
            sourceTargetsRendered = true;
            scene.customRenderTargets.length = 0;
            return;
        }
        renderPostProcesses();
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    }
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
