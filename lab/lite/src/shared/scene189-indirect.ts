export const SCENE189_TRIANGLES = 12;
export const SCENE189_VERTICES = SCENE189_TRIANGLES * 3;
export const SCENE189_STRIDE = 16;

export function buildScene189Slab(): Float32Array {
    const data = new Float32Array(SCENE189_VERTICES * 4);
    for (let triangle = 0; triangle < SCENE189_TRIANGLES; triangle++) {
        const cx = ((triangle % 4) - 1.5) * 1.2;
        const cz = (Math.floor(triangle / 4) - 1) * 1.2;
        const shade = triangle / (SCENE189_TRIANGLES - 1);
        const offset = triangle * 12;
        data.set([cx - 0.42, 0, cz - 0.32, shade, cx + 0.42, 0, cz - 0.32, shade, cx, 0.85, cz, shade], offset);
    }
    return data;
}

export function buildScene189Indices(): Uint32Array {
    return Uint32Array.from({ length: SCENE189_VERTICES }, (_, index) => index);
}

export const SCENE189_ARGS_WGSL = `
@group(0) @binding(0) var<storage, read_write> indirectArgs: array<u32>;
@group(0) @binding(1) var state: texture_storage_3d<r32uint, read_write>;
@compute @workgroup_size(1)
fn main() {
    let previous = textureLoad(state, vec3i(0, 0, 0)).x;
    textureStore(state, vec3i(0, 0, 0), vec4u(${SCENE189_TRIANGLES}u));
    indirectArgs[0] = select(${SCENE189_TRIANGLES}u, previous, previous == ${SCENE189_TRIANGLES}u);
    indirectArgs[1] = 1u;
    indirectArgs[2] = 1u;
}`;

export const SCENE189_FILL_WGSL = `
@group(0) @binding(0) var<storage, read_write> vertices: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(workgroup_id) group: vec3u) {
    let triangle = group.x;
    if (triangle >= ${SCENE189_TRIANGLES}u) { return; }
    let cx = (f32(triangle % 4u) - 1.5) * 1.2;
    let cz = (f32(triangle / 4u) - 1.0) * 1.2;
    let shade = f32(triangle) / ${SCENE189_TRIANGLES - 1}.0;
    let base = triangle * 3u;
    vertices[base] = vec4f(cx - 0.42, 0.0, cz - 0.32, shade);
    vertices[base + 1u] = vec4f(cx + 0.42, 0.0, cz - 0.32, shade);
    vertices[base + 2u] = vec4f(cx, 0.85, cz, shade);
}`;

export const SCENE189_VERTEX_WGSL = `struct VertexOutput{@builtin(position) position:vec4f,@location(0) shade:f32}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4f(input.position.xyz,1);out.shade=input.position.w;return out;}`;
export const SCENE189_FRAGMENT_WGSL = `struct VertexOutput{@builtin(position) position:vec4f,@location(0) shade:f32}
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4f{let a=input.shade;return vec4f(0.15+a*0.75,0.8-a*0.5,0.95-a*0.25,1);}`;
