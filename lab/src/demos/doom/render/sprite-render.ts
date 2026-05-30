// Faithful DOOM sprite rendering: view-space billboards drawn through the same
// palette + COLORMAP path as the world, so monsters/items get correct banded
// light diminishing and depth occlusion against walls.
//
// All visible mobjs are packed into ONE dynamic mesh (rebuilt once per render
// frame). Each mobj is a quad whose center vertex position is the mobj origin in
// world space; the per-vertex `normal.xy` carries the corner offset, applied in
// VIEW space so the quad always faces the camera (Doom has no pitch, so a
// view-space offset is both camera-facing and axis-locked).

import { addToScene, createMeshFromData, createShaderMaterial, removeFromScene, setShaderTexture, type EngineContext, type Mesh, type SceneContext, type ShaderMaterial, type Texture2D } from "babylon-lite";
import type { SpriteImage, SpriteStore } from "./sprites.js";

const DIST_PER_BAND = 224.0;

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) dist: f32,
  @location(2) light: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let viewCenter = shaderSystem.worldView * vec4<f32>(input.position, 1.0);
  let offset = vec4<f32>(input.normal.x, input.normal.y, 0.0, 0.0);
  out.position = shaderSystem.projection * (viewCenter + offset);
  out.dist = length(viewCenter.xyz);
  out.uv = input.uv;
  out.light = vec2<f32>(input.color.r, input.color.g);
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) dist: f32,
  @location(2) light: vec2<f32>,
};
const DIST_PER_BAND: f32 = ${DIST_PER_BAND.toFixed(1)};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(atlasTex, atlasTexSampler, input.uv);
  if (src.a < 0.5) { discard; }
  let idx = floor(src.r * 255.0 + 0.5);
  let sectorLight = input.light.x * 255.0;
  let fullbright = input.light.y;
  let baseRow = clamp(31.0 - floor(sectorLight / 8.0), 0.0, 31.0);
  // Blend between adjacent COLORMAP light levels by distance (matches the wall
  // material) so depth-cueing is a smooth gradient, not hard banding.
  let lightRow = clamp(baseRow + input.dist / DIST_PER_BAND, 0.0, 31.0);
  let row = mix(lightRow, 0.0, step(0.5, fullbright));
  let r0 = floor(row);
  let r1 = min(r0 + 1.0, 31.0);
  let frac = row - r0;
  let u = (idx + 0.5) / 256.0;
  let c0 = textureSample(colormapTex, colormapTexSampler, vec2<f32>(u, (r0 + 0.5) / 34.0));
  let c1 = textureSample(colormapTex, colormapTexSampler, vec2<f32>(u, (r1 + 0.5) / 34.0));
  let lut = mix(c0, c1, frac);
  return vec4<f32>(lut.rgb, 1.0);
}`;

export function createSpriteMaterial(name: string, atlasTex: Texture2D, colormapTex: Texture2D): ShaderMaterial {
    const mat = createShaderMaterial({
        name,
        vertexSource,
        fragmentSource,
        attributes: ["position", "normal", "uv", "color"],
        uniforms: ["worldView", "projection"],
        samplers: ["atlasTex", "colormapTex"],
        backFaceCulling: false,
    });
    setShaderTexture(mat, "atlasTex", atlasTex);
    setShaderTexture(mat, "colormapTex", colormapTex);
    return mat;
}

/** A single mobj to draw this frame. */
export interface RenderSprite {
    /** Doom map X (world X). */
    x: number;
    /** Vertical origin (world Y / Doom z). */
    z: number;
    /** Doom map Y (world Z). */
    y: number;
    image: SpriteImage;
    /** Sector light 0..255. */
    light: number;
    fullbright: boolean;
}

export class SpriteRenderer {
    private material: ShaderMaterial | null = null;
    private mesh: Mesh | null = null;
    private counter = 0;

    constructor(
        private readonly engine: EngineContext,
        private readonly scene: SceneContext,
        private readonly store: SpriteStore,
        private readonly colormapTex: Texture2D
    ) {}

    /** Rebuilds the single sprite mesh from the given visible sprites (call once/frame). */
    rebuild(sprites: RenderSprite[]): void {
        if (this.mesh) {
            removeFromScene(this.scene, this.mesh);
            this.mesh = null;
        }
        const atlas = this.store.atlas;
        if (!atlas || sprites.length === 0) return;

        const n = sprites.length;
        const positions = new Float32Array(n * 12);
        const normals = new Float32Array(n * 12);
        const uvs = new Float32Array(n * 8);
        const colors = new Float32Array(n * 16);
        const indices = new Uint32Array(n * 6);

        const aw = this.store.atlasWidth;
        const ah = this.store.atlasHeight;

        for (let i = 0; i < n; i++) {
            const s = sprites[i]!;
            const img = s.image;
            let left: number;
            let right: number;
            let uL: number;
            let uR: number;
            const u0 = img.ax / aw;
            const u1 = (img.ax + img.aw) / aw;
            if (img.mirror) {
                left = -(img.aw - img.leftOffset);
                right = img.leftOffset;
                uL = u1;
                uR = u0;
            } else {
                left = -img.leftOffset;
                right = img.aw - img.leftOffset;
                uL = u0;
                uR = u1;
            }
            const top = img.topOffset;
            const bottom = img.topOffset - img.ah;
            const v0 = img.ay / ah;
            const v1 = (img.ay + img.ah) / ah;

            const vb = i * 12;
            const ub = i * 8;
            const cb = i * 16;
            const ib = i * 6;
            const base = i * 4;

            // Four corners share the same world-space center; the offset lives in normal.xy.
            for (let c = 0; c < 4; c++) {
                positions[vb + c * 3] = s.x;
                positions[vb + c * 3 + 1] = s.z;
                positions[vb + c * 3 + 2] = s.y;
            }
            // 0 = left/bottom, 1 = right/bottom, 2 = right/top, 3 = left/top
            normals[vb] = left;
            normals[vb + 1] = bottom;
            normals[vb + 3] = right;
            normals[vb + 4] = bottom;
            normals[vb + 6] = right;
            normals[vb + 7] = top;
            normals[vb + 9] = left;
            normals[vb + 10] = top;

            uvs[ub] = uL;
            uvs[ub + 1] = v1;
            uvs[ub + 2] = uR;
            uvs[ub + 3] = v1;
            uvs[ub + 4] = uR;
            uvs[ub + 5] = v0;
            uvs[ub + 6] = uL;
            uvs[ub + 7] = v0;

            const lr = s.light / 255;
            const fb = s.fullbright ? 1 : 0;
            for (let c = 0; c < 4; c++) {
                colors[cb + c * 4] = lr;
                colors[cb + c * 4 + 1] = fb;
                colors[cb + c * 4 + 2] = 0;
                colors[cb + c * 4 + 3] = 1;
            }

            indices[ib] = base;
            indices[ib + 1] = base + 1;
            indices[ib + 2] = base + 2;
            indices[ib + 3] = base;
            indices[ib + 4] = base + 2;
            indices[ib + 5] = base + 3;
        }

        const mesh = createMeshFromData(this.engine, `doom_sprites_${this.counter++}`, positions, normals, indices, uvs, undefined, undefined, colors);
        if (!this.material) {
            this.material = createSpriteMaterial("doomSpriteMat", atlas, this.colormapTex);
        }
        mesh.material = this.material;
        addToScene(this.scene, mesh);
        this.mesh = mesh;
    }

    dispose(): void {
        if (this.mesh) {
            removeFromScene(this.scene, this.mesh);
            this.mesh = null;
        }
    }
}
