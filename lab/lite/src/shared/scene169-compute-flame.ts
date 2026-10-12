export const SCENE169_FLAME_POSITION = [0, 3.18, -0.08] as const;
export const SCENE169_NOISE_SIZE = 64;
export const SCENE169_SEEK_TIME = 1.25;

/** Deterministic grayscale noise shared by the Babylon.js and Lite compute shaders. */
export function buildScene169NoisePixels(): Uint8Array {
    const pixels = new Uint8Array(SCENE169_NOISE_SIZE * SCENE169_NOISE_SIZE * 4);
    let state = 0x6d2b79f5;
    for (let i = 0; i < SCENE169_NOISE_SIZE * SCENE169_NOISE_SIZE; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const value = state >>> 24;
        const offset = i * 4;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 255;
    }
    return pixels;
}

const SCENE169_FLAME_COMMON_WGSL = `
struct Params {
    posFlame: vec4f,
    elapsedTime: f32,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var noiseSampler: sampler;
@group(0) @binding(3) var noiseTexture: texture_2d<f32>;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var depth: texture_depth_2d;

const C0 = vec3f(0.0, 125.0, 255.0) / 255.0;
const C1 = vec3f(255.0, 125.0, 0.0) / 255.0;

fn flame(uv: vec2f) -> vec3f {
    let uv0 = uv * vec2f(10.0, 1.3);
    let uv1 = uv0 * 0.02 - params.elapsedTime * vec2f(0.02, 0.05);
    let random = textureSampleLevel(noiseTexture, noiseSampler, uv1, 0.0).r;
    let y = smoothstep(-0.4, 0.4, uv.y);
    let uv2 = uv0 + random * y * vec2f(0.7, 1.3);
    let color = mix(C0, C1, smoothstep(-0.6, 0.15, uv.y));
    var intensity = smoothstep(-0.2, 0.0, 0.4 - length(uv2));
    intensity *= smoothstep(0.1, 1.0, length(uv2 * vec2f(1.0, 0.6) + vec2f(0.0, 0.35)));
    return intensity * color;
}
`;

export const SCENE169_BJS_FLAME_COMPUTE_WGSL = `${SCENE169_FLAME_COMMON_WGSL}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let coordinate = vec2u(id.x, size.y - 1u - id.y);
    var color = textureLoad(source, coordinate, 0);
    let fragCoord = vec2f(f32(id.x), f32(size.y) - f32(id.y)) - 0.5 * vec2f(size);
    let sizeFactor = vec2f(5.0 * params.posFlame.w / 9.0);
    var uv = fragCoord / vec2f(size) * sizeFactor;
    uv.x += (f32(size.x) * 0.5 - params.posFlame.x) / f32(size.x) * sizeFactor.x;
    let posY = f32(size.y) * (sizeFactor.y + 1.0) / (2.0 * sizeFactor.y);
    uv.y -= (posY - params.posFlame.y) / f32(size.y) * sizeFactor.y;
    let flameColor = pow(tanh(flame(uv) * 8.0), vec3f(2.2));
    let sceneDepth = textureLoad(depth, coordinate, 0);
    if (!all(flameColor == vec3f(0.0)) && sceneDepth < params.posFlame.z) {
        color = vec4f(flameColor, 1.0);
    }
    textureStore(output, coordinate, color);
}`;

export const SCENE169_LITE_FLAME_COMPUTE_WGSL = `${SCENE169_FLAME_COMMON_WGSL}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let coordinate = id.xy;
    var color = textureLoad(source, coordinate, 0);
    let fragCoord = vec2f(f32(id.x), f32(size.y) - f32(id.y)) - 0.5 * vec2f(size);
    let sizeFactor = vec2f(5.0 * params.posFlame.w / 9.0);
    var uv = fragCoord / vec2f(size) * sizeFactor;
    uv.x += (f32(size.x) * 0.5 - params.posFlame.x) / f32(size.x) * sizeFactor.x;
    let posY = f32(size.y) * (sizeFactor.y + 1.0) / (2.0 * sizeFactor.y);
    uv.y -= (posY - params.posFlame.y) / f32(size.y) * sizeFactor.y;
    let flameColor = pow(tanh(flame(uv) * 8.0), vec3f(2.2));
    let sceneDepth = textureLoad(depth, coordinate, 0);
    if (!all(flameColor == vec3f(0.0)) && sceneDepth < params.posFlame.z) {
        color = vec4f(flameColor, 1.0);
    }
    textureStore(output, coordinate, color);
}`;
