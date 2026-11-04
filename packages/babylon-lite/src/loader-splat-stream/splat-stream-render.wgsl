struct ProjectedSplat {
    clipCenter: vec4<f32>,
    axis0: vec4<f32>,
    axis1: vec4<f32>,
    color: vec4<f32>,
}
struct KeyIndex {
    key: u32,
    index: u32,
}
@group(1) @binding(0) var<storage, read> projected: array<ProjectedSplat>;
@group(1) @binding(1) var<storage, read> sorted: array<KeyIndex>;
struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) corner: vec2<f32>,
    @location(1) color: vec4<f32>,
}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(-2.0, -2.0), vec2<f32>(2.0, -2.0), vec2<f32>(2.0, 2.0),
        vec2<f32>(-2.0, -2.0), vec2<f32>(2.0, 2.0), vec2<f32>(-2.0, 2.0)
    );
    let corner = corners[vertex];
    let splat = projected[sorted[instance].index];
    var output: VertexOut;
    output.position = splat.clipCenter + splat.axis0 * corner.x + splat.axis1 * corner.y;
    output.corner = corner;
    output.color = splat.color;
    return output;
}
@fragment
fn fs(input: VertexOut) -> @location(0) vec4<f32> {
    let radius2 = dot(input.corner, input.corner);
    if (radius2 > 4.0) {
        discard;
    }
    return vec4<f32>(input.color.rgb, exp(-radius2) * input.color.a);
}
