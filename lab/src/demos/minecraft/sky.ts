// Procedural sky gradient dome. A large camera-centered sphere whose fragments
// are pushed to the reversed-Z far plane so it fills only the background. The
// colour blends from a horizon tint (matching the fog colour) up to a zenith
// blue, with a soft sun glow. Recenter on the camera each frame.

import { createMeshFromData, createShaderMaterial, createSphereData, setShaderVector3, type EngineContext, type Mesh } from "babylon-lite";

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) dir: vec3<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let clip = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, clip.w);
  out.dir = input.position;
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) dir: vec3<f32>,
};
fn hash3(p: vec3<f32>) -> f32 {
  var q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3));
  q = q * 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
// Sparse twinkling star field in the upper sky.
fn starField(d: vec3<f32>) -> f32 {
  let p = d * 90.0;
  let cell = floor(p);
  let f = fract(p) - 0.5;
  let r = hash3(cell);
  let present = step(0.986, r);
  let dist = length(f);
  let b = smoothstep(0.10, 0.0, dist);
  return present * b * (0.5 + 0.7 * hash3(cell + 7.0));
}
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let d = normalize(input.dir);
  let h = clamp(d.y, 0.0, 1.0);
  let horizon = shaderUniforms.horizonColor;
  let zenith = shaderUniforms.zenithColor;
  var col = mix(horizon, zenith, pow(h, 0.6));
  let sd = normalize(shaderUniforms.sunDir);
  let sunUp = smoothstep(-0.06, 0.10, sd.y);
  // How deep into night we are (sun well below the horizon).
  let night = smoothstep(0.07, -0.12, sd.y);

  // Stars: only the upper hemisphere, fading in at night.
  let stars = starField(d) * night * smoothstep(0.0, 0.15, d.y);
  col = col + vec3<f32>(0.9, 0.93, 1.0) * stars * 1.3;

  // Moon opposite the sun: a soft halo plus a crisp bright disc, night only.
  let md = -sd;
  let moonUp = smoothstep(-0.06, 0.10, md.y);
  let m = max(dot(d, md), 0.0);
  col = col + vec3<f32>(0.55, 0.62, 0.8) * pow(m, 8.0) * 0.12 * moonUp * night;
  let moonDisc = smoothstep(0.9988, 0.9992, m) * moonUp * night;
  // Faint mare shading so the disc reads as a moon, not a blank dot.
  let moonShade = 0.82 + 0.18 * hash3(floor(d * 200.0));
  col = mix(col, vec3<f32>(0.95, 0.95, 0.88) * moonShade, moonDisc);

  // Sun: a purely additive glow that smoothly saturates to a white core, so there
  // is no distinct inner disc — just one soft, bright sun. The center blows out to
  // white naturally (LDR clamp) while the warm tint shows through the mid-glow.
  let s = max(dot(d, sd), 0.0);
  col = col + vec3<f32>(1.0, 0.9, 0.7) * pow(s, 8.0) * 0.16 * sunUp;
  col = col + vec3<f32>(1.0, 0.95, 0.82) * pow(s, 64.0) * 0.7 * sunUp;
  col = col + vec3<f32>(1.0, 0.98, 0.92) * pow(s, 320.0) * 2.2 * sunUp;
  return vec4<f32>(col, 1.0);
}`;

export interface SkyOptions {
    horizonColor?: [number, number, number];
    zenithColor?: [number, number, number];
    sunDir?: [number, number, number];
}

export interface Sky {
    readonly mesh: Mesh;
    /** Set the direction TO the sun (need not be normalised). */
    setSun(dir: [number, number, number]): void;
    /** Set the horizon (lower) and zenith (upper) gradient colours. */
    setColors(horizon: [number, number, number], zenith: [number, number, number]): void;
}

export function createSky(engine: EngineContext, opts: SkyOptions = {}): Sky {
    const horizon = opts.horizonColor ?? [0.7, 0.82, 0.92];
    const zenith = opts.zenithColor ?? [0.28, 0.5, 0.86];
    const sunDir = opts.sunDir ?? [0.5, 0.6, 0.3];
    const data = createSphereData({ segments: 16, diameter: 4000 });
    const mesh = createMeshFromData(engine, "mc_sky", data.positions, data.normals, data.indices, data.uvs);
    const mat = createShaderMaterial({
        name: "mcSky",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: [
            "worldViewProjection",
            { name: "horizonColor", type: "vec3<f32>", defaultValue: horizon },
            { name: "zenithColor", type: "vec3<f32>", defaultValue: zenith },
            { name: "sunDir", type: "vec3<f32>", defaultValue: sunDir },
        ],
        backFaceCulling: false,
        depthWrite: false,
    });
    mesh.material = mat;
    mesh.renderOrder = -1000;
    return {
        mesh,
        setSun(dir: [number, number, number]): void {
            setShaderVector3(mat, "sunDir", dir);
        },
        setColors(horizonColor: [number, number, number], zenithColor: [number, number, number]): void {
            setShaderVector3(mat, "horizonColor", horizonColor);
            setShaderVector3(mat, "zenithColor", zenithColor);
        },
    };
}
