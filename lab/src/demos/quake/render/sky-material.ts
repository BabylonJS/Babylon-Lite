// Authentic Quake sky for the E1M1 demo. Quake doesn't render the sky brush
// texture flatly — it projects the view ray onto two scrolling cloud layers,
// reproducing GLQuake's R_DrawSkyChain / EmitSkyPolys warp. The "sky" miptex is
// 256x128: the left 128x128 half is the solid background layer, the right half
// is the foreground cloud layer whose palette-index-0 texels are holes that
// reveal the background. Both layers scroll over the dome (front twice as fast),
// giving the classic flowing Quake sky. No GPL code copied (factual warp maths).

import { createShaderMaterial, createTexture2DFromPixels, setShaderTexture, type EngineContext, type ShaderMaterial, type Texture2D } from "babylon-lite";

import type { BspMipTex } from "../bsp/parse-bsp.js";
import type { Palette } from "../palette.js";

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let world = shaderSystem.world * vec4<f32>(input.position, 1.0);
  out.worldPos = world.xyz;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  // View ray from the camera to this sky surface, in Quake axes (x fwd, y left,
  // z up). Engine space is y-up, so engine.z maps to Quake.y and engine.y to Quake.z.
  let dirE = input.worldPos - shaderSystem.cameraPosition;
  var d = vec3<f32>(dirE.x, dirE.z, dirE.y);
  d.z = d.z * 3.0; // flatten the dome so the horizon stretches like Quake's
  let len = 6.0 * 63.0 / length(d);
  let sx = d.x * len;
  let sy = d.y * len;
  // Background scrolls at 8 u/s, foreground clouds at 16 u/s (Quake speedscale).
  let t = shaderUniforms.sky.x;
  let backUV = vec2<f32>(fract((t * 8.0 + sx) / 128.0) * 0.5, fract((t * 8.0 + sy) / 128.0));
  let frontUV = vec2<f32>(0.5 + fract((t * 16.0 + sx) / 128.0) * 0.5, fract((t * 16.0 + sy) / 128.0));
  let back = textureSample(skyTex, skyTexSampler, backUV).rgb;
  let front = textureSample(skyTex, skyTexSampler, frontUV);
  let col = mix(back, front.rgb, front.a);
  return vec4<f32>(col, 1.0);
}`;

/** Decode a Quake sky miptex (256x128) into RGBA, making cloud index-0 texels
 *  transparent so the background layer shows through the foreground holes. */
export function createSkyTexture(engine: EngineContext, mt: BspMipTex, palette: Palette): Texture2D {
    const w = mt.width;
    const h = mt.height;
    const half = w >> 1;
    const idx = mt.indices!;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < idx.length; i++) {
        const v = idx[i]!;
        const p = v * 3;
        rgba[i * 4] = palette[p]!;
        rgba[i * 4 + 1] = palette[p + 1]!;
        rgba[i * 4 + 2] = palette[p + 2]!;
        // Right (cloud) half: index 0 is a hole; left (background) half is opaque.
        const x = i % w;
        rgba[i * 4 + 3] = x >= half && v === 0 ? 0 : 255;
    }
    return createTexture2DFromPixels(engine, rgba, w, h, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        minFilter: "nearest",
        magFilter: "nearest",
    });
}

export function createSkyMaterial(name: string, skyTex: Texture2D): ShaderMaterial {
    const mat = createShaderMaterial({
        name,
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: ["world", "worldViewProjection", "cameraPosition", { name: "sky", type: "vec4<f32>" }],
        samplers: ["skyTex"],
        backFaceCulling: false,
    });
    setShaderTexture(mat, "skyTex", skyTex);
    return mat;
}
