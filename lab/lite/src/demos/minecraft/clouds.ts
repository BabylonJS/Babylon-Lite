// Drifting volumetric-looking cloud layer. A single large horizontal quad kept
// centred on the camera (in XZ) at a fixed altitude, textured by procedural fbm
// value-noise in the fragment shader. The noise is sampled in world space (camera
// offset + a slow wind scroll) so the clouds appear anchored to the world and
// drift overhead rather than sticking to the camera. Alpha-blended with a soft
// radial edge fade so the finite quad never shows a hard border, and tinted by the
// current day-night sky colours so they glow at sunset and dim at night.
//
// Pure public-API: hand-built quad geometry uploaded via createMeshFromData and a
// createShaderMaterial shader. No engine internals.

import { addToScene, createMeshFromData, createShaderMaterial, setShaderFloat, setShaderVector3, type EngineContext, type Mesh, type SceneContext } from "babylon-lite";

const CLOUD_Y = 80; // world Y of the cloud layer
const HALF = 420; // half extent of the quad (blocks)

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.local = input.position.xz;
  return out;
}`;

const fragmentSource = `fn hash(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 345.45));
  q = q + dot(q, q + 34.345);
  return fract(q.x * q.y);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + amp * vnoise(q);
    q = q * 2.02;
    amp = amp * 0.5;
  }
  return v;
}
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  // World-anchored sample: camera offset + slow wind drift.
  let wind = vec2<f32>(shaderUniforms.uTime * 1.4, shaderUniforms.uTime * 0.5);
  let sample = (input.local + shaderUniforms.uOffset.xy + wind) * 0.024;
  let n = fbm(sample);
  // Puffy coverage with a soft inner gradient for a hint of body.
  let coverage = smoothstep(0.44, 0.60, n);
  let body = smoothstep(0.46, 0.92, n);
  // Radial edge fade so the quad border is invisible.
  let r = length(input.local) / shaderUniforms.uRadius;
  let edge = 1.0 - smoothstep(0.5, 1.0, r);
  let alpha = coverage * edge;
  if (alpha < 0.01) { discard; }
  // Shade: darker undersides toward gaps, bright tops; tinted by sky colour.
  let col = mix(shaderUniforms.uTint * 0.7, shaderUniforms.uTint, body);
  return vec4<f32>(col, alpha);
}`;

export interface Clouds {
    readonly mesh: Mesh;
    /** Recenter over the camera and advance the wind. */
    update(camX: number, camZ: number, timeSec: number): void;
    /** Tint the clouds with the current sky/sun colour. */
    setTint(color: [number, number, number]): void;
}

export function createClouds(engine: EngineContext, scene: SceneContext): Clouds {
    // Two-triangle quad in the XZ plane (local space), facing up.
    const positions = new Float32Array([-HALF, 0, -HALF, HALF, 0, -HALF, HALF, 0, HALF, -HALF, 0, HALF]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const mesh = createMeshFromData(engine, "mc_clouds", positions, normals, indices, undefined);
    mesh.position.y = CLOUD_Y;

    const mat = createShaderMaterial({
        name: "mcClouds",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: [
            "worldViewProjection",
            { name: "uTime", type: "f32", defaultValue: 0 },
            { name: "uOffset", type: "vec3<f32>", defaultValue: [0, 0, 0] },
            { name: "uTint", type: "vec3<f32>", defaultValue: [1, 1, 1] },
            { name: "uRadius", type: "f32", defaultValue: HALF },
        ],
        backFaceCulling: false,
        depthWrite: false,
        needAlphaBlending: true,
    });
    setShaderFloat(mat, "uRadius", HALF);
    mesh.material = mat;
    // Draw after opaque terrain (so hills occlude clouds at the horizon) but before
    // translucent water.
    mesh.renderOrder = 500;
    addToScene(scene, mesh);

    return {
        mesh,
        update(camX: number, camZ: number, timeSec: number): void {
            mesh.position.x = camX;
            mesh.position.z = camZ;
            setShaderFloat(mat, "uTime", timeSec);
            setShaderVector3(mat, "uOffset", [camX, camZ, 0]);
        },
        setTint(color: [number, number, number]): void {
            setShaderVector3(mat, "uTint", color);
        },
    };
}
