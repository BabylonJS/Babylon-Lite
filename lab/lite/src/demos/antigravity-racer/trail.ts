/**
 * Antigravity Racer — engine trails.
 *
 * A port of the playground's trail (node material 23KY8X#14 + a 1×256 RGBA-float
 * `RawTexture` history): the mesh carries no usable geometry, only UVs, and the
 * vertex shader builds a camera-facing ribbon from the last 256 emitter samples.
 *
 * Lite stores the history in a per-ship `array<vec4<f32>>` storage buffer instead
 * of a float texture — same values, same clamped-linear fetch, one upload per
 * fixed 60 Hz tick, no float-texture-filtering requirement.
 *
 * Geometry: the original is `CreateGround({width:.1, height:.01, subdivisionsY:256})`,
 * i.e. 257 rows × 2 columns. Its history texture is a `RawTexture`, which clamps on
 * both axes, so rows 0 and 256 read the SAME texel for both `v` and `v + 0.001`,
 * yielding `normalize(0)` → NaN → discarded triangles. Only rows 1…255 ever draw, so
 * this builds exactly those: 510 vertices, 254 quads, 1,524 indices, with the same
 * index pattern (and therefore the same winding) `CreateGround` emits.
 */

import type { EngineContext, Mesh, ShaderMaterial, StorageBuffer, Vec3 } from "babylon-lite";
import { createMeshFromData, createShaderMaterial, createStorageBuffer, disposeStorageBuffer, setShaderStorageBuffer, updateStorageBuffer } from "babylon-lite";

import { HUGE_BOUND_MAX, HUGE_BOUND_MIN } from "./constants.js";
import { wgsl, type WgslSource } from "babylon-lite/shader/wgsl.js";

/** History samples kept per ship (`trailLength` in the playground). */
export const TRAIL_HISTORY = 256;
/** Strip rows that actually draw — the original's mesh rows 1…255. */
export const TRAIL_ROWS = TRAIL_HISTORY - 1;

export interface ShipTrail {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;
    /** Append the newest sample: emitter world position + the pre-acceleration speed ratio. */
    push(pos: Vec3, intensity: number): void;
    dispose(): void;
}

/**
 * The static strip. Row `j` (0…254) is the original's mesh row `j + 1`, so it carries
 * `v = (255 - j) / 256`; the two columns carry `u = 0` and `u = 1`.
 */
export function buildTrailStrip(): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array } {
    const vertexCount = TRAIL_ROWS * 2;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let j = 0; j < TRAIL_ROWS; j++) {
        const v = (TRAIL_HISTORY - 1 - j) / TRAIL_HISTORY;
        for (let col = 0; col < 2; col++) {
            const i = j * 2 + col;
            uvs[i * 2] = col;
            uvs[i * 2 + 1] = v;
            normals[i * 3 + 1] = 1;
        }
    }
    const indices = new Uint32Array((TRAIL_ROWS - 1) * 6);
    let ii = 0;
    for (let j = 0; j < TRAIL_ROWS - 1; j++) {
        const a = j * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        // `CreateGround`'s pattern, so the winding (and back-face culling) matches.
        indices[ii++] = d;
        indices[ii++] = b;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = d;
        indices[ii++] = a;
    }
    return { positions, normals, uvs, indices };
}

/** Vertex stage: the node graph, statement for statement. */
function vertexSource(): WgslSource {
    return wgsl`struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) vv: f32,
@location(1) sx: f32,
@location(2) intensity: f32,
};
// Clamped, linearly filtered fetch of the float history buffer — the sampler state
// Babylon's RawTexture gives the original (CLAMP_ADDRESSMODE, LINEAR_LINEAR).
fn sampleHistory(v: f32) -> vec4<f32> {
let t = clamp(v * ${TRAIL_HISTORY}.0 - 0.5, 0.0, ${TRAIL_HISTORY - 1}.0);
let f = floor(t);
let i0 = u32(f);
let i1 = min(i0 + 1u, ${TRAIL_HISTORY - 1}u);
return mix(trailHistory[i0], trailHistory[i1], t - f);
}
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
var out: VertexOutput;
let v = input.uv.y;
let sx = (input.uv.x - 0.5) * 2.0;
let s0 = sampleHistory(v);
let s1 = sampleHistory(v + 0.001);
let tangent = normalize(s0.xyz - s1.xyz);
let view = normalize(s0.xyz - shaderSystem.cameraPosition);
let right = normalize(cross(view, tangent));
let world = s0.xyz + right * (sx * 0.1);
out.position = shaderSystem.viewProjection * vec4<f32>(world, 1.0);
out.vv = v;
out.sx = sx;
out.intensity = s0.w;
return out;
}`;
}

/** Fragment stage: the graph's constant cyan with `sin(3.14·sx) · sin(1.57·v) · intensity` alpha. */
function fragmentSource(): WgslSource {
    return wgsl`struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) vv: f32,
@location(1) sx: f32,
@location(2) intensity: f32,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
let alpha = max(0.0, sin(input.sx * 3.14) * sin(input.vv * 1.57) * input.intensity);
return vec4<f32>(1.0 / 255.0, 213.0 / 255.0, 253.0 / 255.0, alpha);
}`;
}

/**
 * Build one ship's trail. The history is seeded with the spawn position at zero intensity, which
 * reproduces the original's "grow from nothing" without relying on its uninitialised-array NaNs.
 */
export function createShipTrail(engine: EngineContext, startPos: Vec3): ShipTrail {
    const history = new Float32Array(TRAIL_HISTORY * 4);
    const historyBytes = new Uint8Array(history.buffer);
    for (let i = 0; i < TRAIL_HISTORY; i++) {
        history[i * 4] = startPos.x;
        history[i * 4 + 1] = startPos.y;
        history[i * 4 + 2] = startPos.z;
        history[i * 4 + 3] = 0;
    }

    const { positions, normals, uvs, indices } = buildTrailStrip();
    const mesh = createMeshFromData(engine, "ship-trail", positions, normals, indices, uvs);
    // Every vertex is placed by the vertex shader, so the geometric bounds are meaningless —
    // publish the playground's explicit huge box instead so culling never drops a live ribbon.
    mesh.boundMin = HUGE_BOUND_MIN;
    mesh.boundMax = HUGE_BOUND_MAX;

    const material = createShaderMaterial({
        name: "antigrav-trail",
        vertexSource: vertexSource(),
        fragmentSource: fragmentSource(),
        attributes: ["position", "uv"],
        uniforms: ["viewProjection", "cameraPosition"],
        storageBuffers: [{ name: "trailHistory", type: "array<vec4<f32>>" }],
        needAlphaBlending: true,
        depthWrite: false,
        backFaceCulling: true,
    });
    const buffer: StorageBuffer = createStorageBuffer(engine, history, "antigrav-trail-history");
    setShaderStorageBuffer(material, "trailHistory", buffer);
    mesh.material = material;

    let disposed = false;
    return {
        mesh,
        material,
        push(pos: Vec3, intensity: number): void {
            if (disposed) {
                return;
            }
            // `data.shift() x4; data.push(x, y, z, intensity)` — index 0 is the oldest sample.
            history.copyWithin(0, 4);
            const last = (TRAIL_HISTORY - 1) * 4;
            history[last] = pos.x;
            history[last + 1] = pos.y;
            history[last + 2] = pos.z;
            history[last + 3] = intensity;
            updateStorageBuffer(engine, buffer, historyBytes);
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeStorageBuffer(buffer);
        },
    };
}
