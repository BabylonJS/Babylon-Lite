// Scene 241 — AnimationPointerUVs (cx20 gltf-test parity)
import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene, onBeforeRender, goToFrame, pauseAnimation } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/AnimationPointerUVs/glTF/AnimationPointerUVs.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const params = new URLSearchParams(window.location.search);
    const pf = (k: string, d: number): number => {
        const v = parseFloat(params.get(k) || "");
        return isNaN(v) ? d : v;
    };
    const cam = createArcRotateCamera(pf("camAlpha", 1.5707963), pf("camBeta", 1.5707963), pf("camRadius", 16), { x: pf("camTX", -0.113), y: pf("camTY", 0.537), z: pf("camTZ", -0.031) });
    cam.fov = pf("camFov", 0.8);
    cam.nearPlane = 16 * 0.01;
    cam.farPlane = 16 * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    scene.fixedDeltaMs = 16.0;
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        if (!isNaN(seekTimeParam) && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
                pauseAnimation(g);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    (window as any).__scene = scene;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
