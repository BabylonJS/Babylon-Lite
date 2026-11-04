export const SCENE188_GRID = 24;
export const SCENE188_VERTS_PER_CHUNK = SCENE188_GRID * SCENE188_GRID;
export const SCENE188_CHUNKS = 4;
export const SCENE188_VERTS_TOTAL = SCENE188_VERTS_PER_CHUNK * SCENE188_CHUNKS;
export const SCENE188_CHUNK_SIZE = 2;
export const SCENE188_STRIDE = 16;
export const SCENE188_NOISE_SIZE = 4;

export const SCENE188_CHUNK_ORIGINS: readonly [number, number][] = [
    [-SCENE188_CHUNK_SIZE, -SCENE188_CHUNK_SIZE],
    [0, -SCENE188_CHUNK_SIZE],
    [-SCENE188_CHUNK_SIZE, 0],
    [0, 0],
];

export function buildScene188Noise(): Uint8Array {
    const data = new Uint8Array(SCENE188_NOISE_SIZE ** 3 * 4);
    for (let i = 0; i < SCENE188_NOISE_SIZE ** 3; i++) {
        const value = (i * 73 + 41) & 255;
        data[i * 4] = value;
        data[i * 4 + 1] = value;
        data[i * 4 + 2] = value;
        data[i * 4 + 3] = 255;
    }
    return data;
}

export function buildScene188Slab(): Float32Array {
    const noise = buildScene188Noise();
    const data = new Float32Array(SCENE188_VERTS_TOTAL * 4);
    let n = 0;
    for (let chunk = 0; chunk < SCENE188_CHUNKS; chunk++) {
        const [ox, oz] = SCENE188_CHUNK_ORIGINS[chunk]!;
        const tint = chunk * 0.18 - 0.27;
        for (let gz = 0; gz < SCENE188_GRID; gz++) {
            for (let gx = 0; gx < SCENE188_GRID; gx++) {
                const x = ox + (gx / (SCENE188_GRID - 1)) * SCENE188_CHUNK_SIZE;
                const z = oz + (gz / (SCENE188_GRID - 1)) * SCENE188_CHUNK_SIZE;
                const noiseIndex = (((chunk % SCENE188_NOISE_SIZE) * SCENE188_NOISE_SIZE + (gz % SCENE188_NOISE_SIZE)) * SCENE188_NOISE_SIZE + (gx % SCENE188_NOISE_SIZE)) * 4;
                const h = Math.sin(x * 1.7) * Math.cos(z * 1.7) * 0.42 + (noise[noiseIndex]! / 255 - 0.5) * 0.08;
                data[n++] = x;
                data[n++] = h;
                data[n++] = z;
                data[n++] = h + tint;
            }
        }
    }
    return data;
}

export function buildScene188Indices(): Uint32Array {
    const indices = new Uint32Array((SCENE188_GRID - 1) * (SCENE188_GRID - 1) * 6);
    let n = 0;
    for (let z = 0; z < SCENE188_GRID - 1; z++) {
        for (let x = 0; x < SCENE188_GRID - 1; x++) {
            const a = z * SCENE188_GRID + x;
            const b = a + 1;
            const c = a + SCENE188_GRID;
            const d = c + 1;
            indices[n++] = a;
            indices[n++] = b;
            indices[n++] = c;
            indices[n++] = b;
            indices[n++] = d;
            indices[n++] = c;
        }
    }
    return indices;
}

export const SCENE188_COMPUTE_WGSL = `
struct ChunkParams { ox: f32, oz: f32, tint: f32, pad: f32 }
@group(0) @binding(0) var<storage, read> params: array<ChunkParams>;
@group(0) @binding(1) var<storage, read_write> slab: array<vec4f>;
@group(0) @binding(2) var noiseVolume: texture_3d<f32>;
@group(0) @binding(3) var noiseLayers: texture_2d_array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= ${SCENE188_VERTS_TOTAL}u) { return; }
    let chunk = i / ${SCENE188_VERTS_PER_CHUNK}u;
    let vertex = i % ${SCENE188_VERTS_PER_CHUNK}u;
    let gx = vertex % ${SCENE188_GRID}u;
    let gz = vertex / ${SCENE188_GRID}u;
    let p = params[chunk];
    let x = p.ox + f32(gx) / ${SCENE188_GRID - 1}.0 * ${SCENE188_CHUNK_SIZE}.0;
    let z = p.oz + f32(gz) / ${SCENE188_GRID - 1}.0 * ${SCENE188_CHUNK_SIZE}.0;
    let coordinate = vec2i(i32(gx % ${SCENE188_NOISE_SIZE}u), i32(gz % ${SCENE188_NOISE_SIZE}u));
    let layer = i32(chunk % ${SCENE188_NOISE_SIZE}u);
    let noise = (textureLoad(noiseVolume, vec3i(coordinate, layer), 0).r + textureLoad(noiseLayers, coordinate, layer, 0).r) * 0.5;
    let h = sin(x * 1.7) * cos(z * 1.7) * 0.42 + (noise - 0.5) * 0.08;
    slab[i] = vec4f(x, h, z, h + p.tint);
}`;

export const SCENE188_VERTEX_WGSL = `struct VertexOutput{@builtin(position) position:vec4f,@location(0) shade:f32}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4f(input.position.xyz,1);out.shade=input.position.w;return out;}`;
export const SCENE188_FRAGMENT_WGSL = `struct VertexOutput{@builtin(position) position:vec4f,@location(0) shade:f32}
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4f{let t=clamp(input.shade*0.9+0.5,0,1);return vec4f(0.1+t*0.35,0.35+t*0.5,0.55+t*0.4,1);}`;
