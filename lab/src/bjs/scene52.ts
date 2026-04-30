// Reference scene 52 — HUD on 3D (BJS).
//
// Mirrors lab/src/lite/scene52.ts using a regular `Scene` + `SpriteManager`
// — the natural BJS equivalent of Lite's "3D scene under a HUD overlay".
//
// Composition:
//   - 3D pass: ArcRotateCamera + DirectionalLight + Sphere (StandardMaterial).
//   - HUD pass: a `SpriteManager` with `renderingGroupId = 1` (drawn after
//     the 3D pass) and `disableDepthWrite = true` (matches Lite's
//     `depth: "none"` HUD layer).
//
// Sprite positions are in world space here (BJS sprites don't natively have a
// pixel-space layout without a 2nd orthographic camera). The HUD sprite count
// (13) and atlas match Lite, which is what matters for the perf comparison
// — exact screen positions are irrelevant to the per-frame workload.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import "@babylonjs/core/Materials/standardMaterial";
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

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 5, new Vector3(0, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 10000;

    const light = new DirectionalLight("dir", new Vector3(0, -1, 0), scene);
    light.diffuse = new Color3(1, 0, 0);
    light.specular = new Color3(0, 1, 0);

    MeshBuilder.CreateSphere("sphere", { segments: 32 }, scene);

    // HUD overlay — drawn after the 3D pass via `renderingGroupId = 1`. The
    // matching Lite layer uses `depth: "none"` so we mirror with
    // `disableDepthWrite = true`.
    const hud = new SpriteManager("hud", getSpriteAtlasDataUrl(), 16, { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx }, scene);
    hud.renderingGroupId = 1;
    hud.disableDepthWrite = true;

    addHudSprites(hud);

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

/**
 * 13 HUD sprites laid out in world space — matches Lite's HUD sprite count
 * (8 icon strip + 4 action bar + 1 centre cross-hair). Positions are picked
 * to keep the layout visually plausible from the default ArcRotateCamera, but
 * exact screen positions are not required: the perf workload is what matters.
 */
function addHudSprites(manager: SpriteManager): void {
    // Top-row icon strip (mirrors the 8 frames 8..15 in the Lite HUD).
    for (let i = 0; i < 8; i++) {
        const s = new Sprite("hud-icon-" + i, manager);
        s.position = new Vector3(-2.1 + i * 0.6, 1.6, 0);
        s.size = 0.35;
        s.cellIndex = 8 + i;
        s.color = i < 5 ? new Color4(1, 1, 1, 1) : new Color4(0.35, 0.35, 0.35, 1);
    }

    // Bottom-centre action bar (frames 16..19).
    for (let i = 0; i < 4; i++) {
        const s = new Sprite("hud-bar-" + i, manager);
        s.position = new Vector3(-0.9 + i * 0.6, -1.6, 0);
        s.size = 0.4;
        s.cellIndex = 16 + i;
        s.color = i % 2 === 0 ? new Color4(1, 1, 1, 1) : new Color4(0.7, 1, 0.85, 1);
    }

    // Centre cross-hair (frame 24).
    const center = new Sprite("hud-center", manager);
    center.position = new Vector3(0, 0, 0);
    center.size = 0.6;
    center.cellIndex = 24;
    center.color = new Color4(1, 0.85, 0.65, 1);
}
