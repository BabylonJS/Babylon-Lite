/**
 * DOOM demo — Phase -1 capability spike.
 *
 * Proves, using ONLY the public `babylon-lite` barrel, the three rendering
 * primitives the faithful Doom look depends on:
 *   1. Textures created from CPU-generated pixel bytes (`createTexture2DFromPixels`).
 *   2. A custom WGSL material doing nearest-neighbor sampling + Doom-style
 *      COLORMAP light diminishing (banded distance darkening, NOT smooth RGB).
 *   3. Axis-locked, alpha-cutout billboard sprites correctly occluded by walls.
 *
 * All texture data here is procedural and original — no WAD parsing, no id
 * Software or Freedoom assets are loaded yet. Phase 0 replaces these procedural
 * generators with real WAD/IWAD decoders.
 */

import {
    addAxisLockedBillboardSystem,
    addBillboardSpriteIndex,
    addToScene,
    createArcRotateCamera,
    createAxisLockedBillboardSystem,
    createEngine,
    createGridSpriteAtlas,
    createMeshFromData,
    createSceneContext,
    createShaderMaterial,
    createTexture2DFromPixels,
    registerScene,
    setShaderTexture,
    startEngine,
} from "babylon-lite";

const WALL_PX = 64;
const SPRITE_PX = 64;

/** A tiny indexed palette (RGB triples) standing in for PLAYPAL until Phase 0. */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [24, 16, 12], // 0 mortar dark
    [60, 40, 28], // 1 mortar
    [120, 52, 40], // 2 brick
    [156, 76, 56], // 3 brick light
    [92, 36, 28], // 4 brick dark
    [200, 120, 90], // 5 highlight
];

/** Build a 64×64 RGBA brick texture from the stand-in palette. */
function makeWallTexture(): Uint8Array {
    const data = new Uint8Array(WALL_PX * WALL_PX * 4);
    const brickH = 16;
    const brickW = 32;
    for (let y = 0; y < WALL_PX; y++) {
        const row = Math.floor(y / brickH);
        const xOffset = row % 2 === 0 ? 0 : brickW / 2;
        for (let x = 0; x < WALL_PX; x++) {
            const localY = y % brickH;
            const localX = (x + xOffset) % brickW;
            let idx: number;
            if (localY < 2 || localX < 2) {
                idx = 1; // mortar lines
            } else {
                // pseudo-random brick shading, deterministic per brick cell
                const cell = (row * 7 + Math.floor((x + xOffset) / brickW) * 13) % 3;
                idx = 2 + cell;
                if (localY === 2 || localX === 2) idx = 5; // top/left highlight
            }
            const [r, g, b] = PALETTE[idx];
            const o = (y * WALL_PX + x) * 4;
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = 255;
        }
    }
    return data;
}

/** Build a 64×64 RGBA humanoid silhouette with a transparent background. */
function makeSpriteTexture(): Uint8Array {
    const data = new Uint8Array(SPRITE_PX * SPRITE_PX * 4);
    const cx = SPRITE_PX / 2;
    for (let y = 0; y < SPRITE_PX; y++) {
        for (let x = 0; x < SPRITE_PX; x++) {
            const o = (y * SPRITE_PX + x) * 4;
            let on = false;
            // head
            if (y >= 6 && y < 18 && Math.abs(x - cx) < 6) on = true;
            // torso
            if (y >= 18 && y < 42 && Math.abs(x - cx) < 12) on = true;
            // legs
            if (y >= 42 && y < 60 && (Math.abs(x - cx) < 5 || (Math.abs(x - cx) > 6 && Math.abs(x - cx) < 11))) on = true;
            if (on) {
                const shade = 120 + ((x * 3 + y * 5) % 80);
                data[o] = shade;
                data[o + 1] = Math.floor(shade * 0.5);
                data[o + 2] = Math.floor(shade * 0.3);
                data[o + 3] = 255;
            } else {
                data[o + 3] = 0; // transparent → cutout discards it
            }
        }
    }
    return data;
}

/** Wall quad: position (x,y,z), uv. Centered, facing +z. */
function wallGeometry(width: number, height: number): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs: Float32Array } {
    const hw = width / 2;
    const positions = new Float32Array([-hw, 0, 0, hw, 0, 0, hw, height, 0, -hw, height, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    // V flipped so texture top maps to wall top (texel origin is top-left).
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    return { positions, normals, indices, uvs };
}

const wallVertex = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) viewPos: vec3<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.viewPos = (shaderSystem.worldView * vec4<f32>(input.position, 1.0)).xyz;
  out.uv = input.uv;
  return out;
}`;

// COLORMAP-style light diminishing: brightness falls off with view distance in
// discrete bands (Doom uses 32 colormap rows), not smoothly.
const wallFragment = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) viewPos: vec3<f32>,
};
const LIGHT_LEVELS: f32 = 16.0;
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let texel = textureSample(wallTex, wallTexSampler, input.uv);
  let dist = length(input.viewPos);
  // sector base light 1.0; darken with distance, quantized into bands.
  let lin = clamp(1.0 - dist * 0.06, 0.0, 1.0);
  let banded = floor(lin * LIGHT_LEVELS) / LIGHT_LEVELS;
  return vec4<f32>(texel.rgb * banded, 1.0);
}`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.02, g: 0.02, b: 0.03, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 9, { x: 0, y: 1.4, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 200;
    scene.camera = camera;

    // ── Wall (textured, nearest, COLORMAP-banded lighting) ──
    const wallTex = createTexture2DFromPixels(engine, makeWallTexture(), WALL_PX, WALL_PX, {
        addressModeU: "repeat",
        addressModeV: "repeat",
    });
    const wallMat = createShaderMaterial({
        name: "doomWall",
        vertexSource: wallVertex,
        fragmentSource: wallFragment,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection", "worldView"],
        samplers: ["wallTex"],
        backFaceCulling: false,
    });
    setShaderTexture(wallMat, "wallTex", wallTex);

    const geo = wallGeometry(8, 3);
    const wall = createMeshFromData(engine, "wall", geo.positions, geo.normals, geo.indices, geo.uvs);
    wall.material = wallMat;
    addToScene(scene, wall);

    // ── Sprite billboards (axis-locked Y, alpha-cutout) ──
    const spriteTex = createTexture2DFromPixels(engine, makeSpriteTexture(), SPRITE_PX, SPRITE_PX);
    const atlas = createGridSpriteAtlas(spriteTex, { cellWidthPx: SPRITE_PX, cellHeightPx: SPRITE_PX });
    const billboards = createAxisLockedBillboardSystem(atlas, [0, 1, 0], { blendMode: "cutout", alphaCutoff: 0.5 });

    // One in front of the wall (fully visible), one behind it (occluded by depth).
    addBillboardSpriteIndex(billboards, { position: [-2.5, 1, 2.5], sizeWorld: [2, 2], frame: 0 });
    addBillboardSpriteIndex(billboards, { position: [2.5, 1, -2.5], sizeWorld: [2, 2], frame: 0 });
    addAxisLockedBillboardSystem(scene, billboards);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) canvas.dataset.error = String(err);
});
