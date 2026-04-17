import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import "@babylonjs/core/Helpers/sceneHelpers";

// Seeded PRNG — must match Lite scene exactly
function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0x100000000;
    };
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.performancePriority = ScenePerformancePriority.Aggressive;
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2, 80, Vector3.Zero(), scene);
    cam.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 1.0;

    const random = seededRandom(42);

    const sphereCount = 2500;
    const materialCount = 150;
    const materials: PBRMaterial[] = [];

    for (let i = 0; i < materialCount; i++) {
        const pbr = new PBRMaterial("mat " + i, scene);
        pbr.emissiveColor = new Color3(random(), random(), random());
        materials.push(pbr);
    }

    const meshes: any[] = [];
    for (let i = 0; i < sphereCount; i++) {
        const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
        sphere.position = new Vector3(20 - random() * 40, 20 - random() * 40, 20 - random() * 40);
        sphere.material = materials[i % materialCount]!;
        meshes.push(sphere);
    }

    // Parent hierarchy (chains of 5)
    const levelMax = 5;
    let level = 0;
    for (let i = 0; i < sphereCount; i++) {
        if (level !== 0) {
            meshes[i].setParent(meshes[i - 1]);
        }
        level++;
        if (level >= levelMax) {
            level = 0;
        }
    }

    scene.createDefaultEnvironment();

    // seekTime support for parity testing
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frozen = false;

    scene.useConstantAnimationDeltaTime = true;

    scene.onBeforeRenderObservable.add(() => {
        if (frozen) {
            return;
        }

        if (!isNaN(seekTimeParam)) {
            if (seekTimeParam === 0) {
                frozen = true;
                canvas.dataset.animationFrozen = "true";
                return;
            }
            const seekFrames = seekTimeParam * 60;
            for (let f = 0; f < seekFrames; f++) {
                for (const m of meshes) {
                    m.rotation.y += 0.01;
                }
            }
            frozen = true;
            canvas.dataset.animationFrozen = "true";
            return;
        }

        for (const m of meshes) {
            m.rotation.y += 0.01;
        }
    });

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
