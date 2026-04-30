// Reference scene 53 — Depth-hosted sprites mixed with 3D (BJS).
//
// Mirrors lab/src/lite/scene53.ts using a regular `Scene` + `SpriteManager`.
// BJS sprites participate in the scene's depth attachment by default
// (`disableDepthWrite = false`) — same effect as Lite's
// `depth: "test-write"` flag on the sprite layer.
//
// Composition (matches Lite scene 53):
//   - ArcRotateCamera at radius 8 (alpha=-π/2, beta=π/2 — looks down +Z).
//   - HemisphericLight + 2 boxes (front-left RED, back-right BLUE).
//   - One `SpriteManager` with 3 sprites at different camera-distances:
//        A: in front of both boxes
//        B: between front and back boxes
//        C: behind the back box
//
// World-space Z mirrors Lite's per-instance Z values: closer-to-camera
// sprites occlude meshes; further sprites are occluded.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";

// `SpriteManager` calls `engine.setAlphaMode(...)` via `SpriteRenderer`. Scene
// usually pulls this in transitively, but importing explicitly is harmless and
// makes the dependency obvious.
import "@babylonjs/core/Engines/Extensions/engine.alpha";

// Force the WGSL sprite shaders into the main bundle (otherwise dynamically
// imported by SpriteRenderer). Same pattern as scene 50/51 — keeps the
// per-frame timing free of one-off shader-fetch jitter.
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 8, new Vector3(0, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 100;

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);

    // Front-left RED box (matches Lite at world (-1.5, 0, -2)).
    const front = MeshBuilder.CreateBox("front", { size: 2 }, scene);
    front.position = new Vector3(-1.5, 0, -2);
    const frontMat = new StandardMaterial("frontMat", scene);
    frontMat.diffuseColor = new Color3(0.85, 0.25, 0.25);
    front.material = frontMat;

    // Back-right BLUE box (matches Lite at world (1.5, 0, 2)).
    const back = MeshBuilder.CreateBox("back", { size: 2 }, scene);
    back.position = new Vector3(1.5, 0, 2);
    const backMat = new StandardMaterial("backMat", scene);
    backMat.diffuseColor = new Color3(0.25, 0.4, 0.85);
    back.material = backMat;

    // Three sprites at staggered camera-distances. BJS sprites default to
    // depth-test + depth-write, which matches Lite's `depth: "test-write"`.
    const sprites = new SpriteManager("sprites", getSpriteAtlasDataUrl(), 4, { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx }, scene);

    // A — yellow "0", world z=-3 (in front of both boxes).
    const a = new Sprite("a", sprites);
    a.position = new Vector3(-2, 0, -3);
    a.size = 1.5;
    a.cellIndex = 24;
    a.color = new Color4(1.0, 0.95, 0.4, 1.0);

    // B — cyan "1", world z=0 (between front box at z=-2 and back box at z=2).
    const b = new Sprite("b", sprites);
    b.position = new Vector3(0, 0, 0);
    b.size = 1.5;
    b.cellIndex = 25;
    b.color = new Color4(0.4, 0.9, 1.0, 1.0);

    // C — magenta "2", world z=3 (behind back box).
    const c = new Sprite("c", sprites);
    c.position = new Vector3(2, 0, 3);
    c.size = 1.5;
    c.cellIndex = 26;
    c.color = new Color4(1.0, 0.5, 0.9, 1.0);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
