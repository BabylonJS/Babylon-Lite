// Scene 118 — Billboard Sprite Picking
// Picks one camera-facing billboard via `pickBillboardSprite`, then places a small marker
// mesh just in front of the picked billboard's anchor to visualize the hit. The BJS oracle
// does the same with `scene.pickSprite`, so both the picking AND the pixels are compared.

import type { EngineContext, Mesh, Vec3Tuple } from "babylon-lite";
import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createFacingBillboardSystem,
    createSceneContext,
    createStandardMaterial,
    getCameraPosition,
    loadSpriteAtlas,
    pickBillboardSprite,
    registerScene,
    startEngine,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

type ColorTuple = [number, number, number];

// World anchor of the centre billboard (the deterministic pick target at screen centre).
const TARGET_ANCHOR: Vec3Tuple = [0, 0, 0];
// How far in front of the billboard (toward the camera) the marker floats, in world units.
const MARKER_OFFSET = 0.5;

function createUnlitMaterial(color: ColorTuple) {
    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = color;
    material.specularColor = [0, 0, 0];
    material.disableLighting = true;
    return material;
}

function createMarker(engine: EngineContext): Mesh {
    const marker = createBox(engine, 1);
    marker.name = "scene118-pick-marker";
    marker.material = createUnlitMaterial([1, 0.18, 0.82]);
    marker.scaling.set(0.22, 0.22, 0.22);
    marker.position.set(0, -10, 0); // off-screen until the pick resolves
    marker.pickable = false; // never occlude or steal the billboard pick
    return marker;
}

function formatVec3(value: Vec3Tuple | null): string {
    return value ? value.map((v) => v.toPrecision(12)).join(",") : "";
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.16, g: 0.18, b: 0.22, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 7, { x: 0, y: 0, z: 0 });
    camera.fov = 0.8;
    camera.nearPlane = 1;
    camera.farPlane = 100;
    scene.camera = camera;

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 4 });
    // Order matters: the centre billboard (index 1) is the pick target at screen centre.
    addBillboardSpriteIndex(billboards, { position: [-2, 0.5, 0], sizeWorld: [1.5, 1.5], frame: 8, color: [1, 1, 1, 0.95] });
    const targetIndex = addBillboardSpriteIndex(billboards, { position: TARGET_ANCHOR, sizeWorld: [1.8, 1.8], frame: 13, color: [1, 1, 1, 0.95] });
    addBillboardSpriteIndex(billboards, { position: [2, -0.5, 0], sizeWorld: [1.5, 1.5], frame: 18, color: [1, 1, 1, 0.95] });
    addFacingBillboardSystem(scene, billboards);

    const marker = createMarker(engine);
    addToScene(scene, marker);

    await registerScene(scene);
    await startEngine(engine);
    await waitFrames(4);

    // The centre billboard sits at the camera target, so it projects to screen centre.
    const pick = await pickBillboardSprite(scene, canvas.clientWidth / 2, canvas.clientHeight / 2);

    let markerPlaced = false;
    let pickNearAnchor = false;
    if (pick && pick.pickedPoint) {
        // Float the marker toward the camera so it reads clearly in front of the billboard.
        // Derived from the deterministic anchor (not the depth point) so Lite and BJS match exactly.
        const cam = getCameraPosition(camera);
        const dx = cam.x - TARGET_ANCHOR[0];
        const dy = cam.y - TARGET_ANCHOR[1];
        const dz = cam.z - TARGET_ANCHOR[2];
        const inv = MARKER_OFFSET / Math.hypot(dx, dy, dz);
        marker.position.set(TARGET_ANCHOR[0] + dx * inv, TARGET_ANCHOR[1] + dy * inv, TARGET_ANCHOR[2] + dz * inv);
        markerPlaced = true;
        pickNearAnchor = distance(pick.pickedPoint, TARGET_ANCHOR) < 0.6;
    }

    await waitFrames(4);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickedHit = pick ? String(pick.spriteIndex) : "miss";
    canvas.dataset.systemMatch = String(pick?.system === billboards);
    canvas.dataset.targetIndex = String(targetIndex);
    canvas.dataset.markerPlaced = String(markerPlaced);
    canvas.dataset.pickNearAnchor = String(pickNearAnchor);
    canvas.dataset.pickPoint = formatVec3(pick?.pickedPoint ?? null);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
