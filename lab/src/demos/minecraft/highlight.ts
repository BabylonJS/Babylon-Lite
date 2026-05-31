// Block selection outline. A unit box rendered slightly enlarged with a shader
// that keeps the pixels near each face's border and adds a soft falloff halo,
// producing a glowing wireframe around the targeted block. Additive-blended and
// gently pulsing so it reads clearly against both bright and dark blocks. Hidden
// by collapsing its scale when there is no target.

import { createBox, createShaderMaterial, setShaderFloat, type EngineContext, type Mesh } from "babylon-lite";

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.uv = input.uv;
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  // Distance to the nearest face border in UV space (0 at the edge, 0.5 at center).
  let d = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  // Bright crisp core line plus a wider soft halo that fades outward.
  let core = 1.0 - smoothstep(0.0, 0.022, d);
  let halo = pow(1.0 - smoothstep(0.0, 0.17, d), 1.5);
  let pulse = 0.78 + 0.22 * sin(shaderUniforms.uTime * 4.5);
  let intensity = (core + halo * 0.5) * pulse;
  if (intensity < 0.01) { discard; }
  // Cyan-white energy glow, additively blended (alpha is the additive weight).
  let glow = vec3<f32>(0.55, 0.95, 1.0);
  return vec4<f32>(glow, intensity);
}`;

export interface Highlight {
    mesh: Mesh;
    show(bx: number, by: number, bz: number): void;
    hide(): void;
    /** Drive the pulse animation; call once per frame with elapsed seconds. */
    setTime(t: number): void;
}

export function createHighlight(engine: EngineContext): Highlight {
    const mesh = createBox(engine, 1.01);
    const mat = createShaderMaterial({
        name: "mcHighlight",
        vertexSource,
        fragmentSource,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection", { name: "uTime", type: "f32", defaultValue: 0 }],
        backFaceCulling: false,
        depthWrite: false,
        needAlphaBlending: true,
        blendMode: "additive",
    });
    mesh.material = mat;
    mesh.renderOrder = 2000;
    mesh.scaling.x = mesh.scaling.y = mesh.scaling.z = 0;

    return {
        mesh,
        show(bx, by, bz) {
            mesh.scaling.x = mesh.scaling.y = mesh.scaling.z = 1;
            mesh.position.x = bx + 0.5;
            mesh.position.y = by + 0.5;
            mesh.position.z = bz + 0.5;
        },
        hide() {
            mesh.scaling.x = mesh.scaling.y = mesh.scaling.z = 0;
        },
        setTime(t) {
            setShaderFloat(mat, "uTime", t);
        },
    };
}
