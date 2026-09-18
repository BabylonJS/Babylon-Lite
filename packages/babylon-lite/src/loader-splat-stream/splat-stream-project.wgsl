struct CanonicalSplat {
    centerOpacity: vec4<f32>,
    covarianceA: vec4<f32>,
    covarianceB: vec4<f32>,
    color: vec4<f32>,
}
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
struct ProjectParams {
    worldView: mat4x4<f32>,
    projection: mat4x4<f32>,
    linearWorldView: mat3x3<f32>,
    count: u32,
    width: f32,
    height: f32,
    near: f32,
}
struct DrawArgs {
    vertexCount: u32,
    instanceCount: atomic<u32>,
    firstVertex: u32,
    firstInstance: u32,
}
@group(0) @binding(0) var<storage, read> canonical: array<CanonicalSplat>;
@group(0) @binding(1) var<storage, read_write> projected: array<ProjectedSplat>;
@group(0) @binding(2) var<storage, read_write> keys: array<KeyIndex>;
@group(0) @binding(3) var<storage, read_write> args: DrawArgs;
@group(0) @binding(4) var<uniform> params: ProjectParams;

fn finite4(v: vec4<f32>) -> bool {
    return all(v == v) && all(abs(v) <= vec4<f32>(3.402823e38));
}
fn finite2(v: vec2<f32>) -> bool {
    return all(v == v) && all(abs(v) <= vec2<f32>(3.402823e38));
}
fn invalid(index: u32) {
    keys[index] = KeyIndex(0xffffffffu, index);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    if (index >= params.count) {
        return;
    }
    invalid(index);
    let splat = canonical[index];
    if (!(splat.centerOpacity.w > 0.0) || !finite4(splat.centerOpacity) || !finite4(splat.covarianceA) || !finite4(splat.covarianceB) || !finite4(splat.color)) {
        return;
    }
    let viewCenter = params.worldView * vec4<f32>(splat.centerOpacity.xyz, 1.0);
    let clip = params.projection * viewCenter;
    if (!(viewCenter.z > params.near) || clip.w == 0.0 || !finite4(viewCenter) || !finite4(clip)) {
        return;
    }
    let centerBounds = 1.2 * clip.w;
    if (clip.x < -centerBounds || clip.x > centerBounds || clip.y < -centerBounds || clip.y > centerBounds) {
        return;
    }
    let c = mat3x3<f32>(
        vec3<f32>(splat.covarianceA.x, splat.covarianceA.y, splat.covarianceA.z),
        vec3<f32>(splat.covarianceA.y, splat.covarianceA.w, splat.covarianceB.x),
        vec3<f32>(splat.covarianceA.z, splat.covarianceB.x, splat.covarianceB.y)
    );
    let a = params.linearWorldView;
    let cv = a * c * transpose(a);
    let invW2 = 1.0 / (clip.w * clip.w);
    let px = vec3<f32>(params.projection[0].x, params.projection[1].x, params.projection[2].x);
    let py = vec3<f32>(params.projection[0].y, params.projection[1].y, params.projection[2].y);
    let pw = vec3<f32>(params.projection[0].w, params.projection[1].w, params.projection[2].w);
    let jx = (px * clip.w - pw * clip.x) * invW2 * (params.width * 0.5);
    let jy = (py * clip.w - pw * clip.y) * invW2 * (params.height * 0.5);
    let cvjx = cv * jx;
    let cvjy = cv * jy;
    let covariance2d = vec3<f32>(dot(jx, cvjx) + 0.3, dot(jx, cvjy), dot(jy, cvjy) + 0.3);
    if (!all(covariance2d == covariance2d) || !all(abs(covariance2d) <= vec3<f32>(3.402823e38))) {
        return;
    }
    let trace = covariance2d.x + covariance2d.z;
    let disc = sqrt(max(0.0, (covariance2d.x - covariance2d.z) * (covariance2d.x - covariance2d.z) + 4.0 * covariance2d.y * covariance2d.y));
    let lambda0 = max(0.1, (trace + disc) * 0.5);
    let lambda1 = max(0.1, (trace - disc) * 0.5);
    var direction = vec2<f32>(0.0);
    if (abs(covariance2d.y) + abs(lambda0 - covariance2d.x) > 1e-6) {
        direction = normalize(vec2<f32>(covariance2d.y, lambda0 - covariance2d.x));
    } else {
        direction = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), covariance2d.x >= covariance2d.z);
    }
    let perpendicular = vec2<f32>(-direction.y, direction.x);
    let pixelAxis0 = direction * min(sqrt(2.0 * lambda0), 1024.0);
    let pixelAxis1 = perpendicular * min(sqrt(2.0 * lambda1), 1024.0);
    let clipAxis0 = vec2<f32>(pixelAxis0.x / params.width, pixelAxis0.y / params.height) * clip.w;
    let clipAxis1 = vec2<f32>(pixelAxis1.x / params.width, pixelAxis1.y / params.height) * clip.w;
    if (!finite2(clipAxis0) || !finite2(clipAxis1)) {
        return;
    }
    let extent = 2.0 * (abs(clipAxis0) + abs(clipAxis1));
    if (clip.x + extent.x < -clip.w || clip.x - extent.x > clip.w || clip.y + extent.y < -clip.w || clip.y - extent.y > clip.w) {
        return;
    }
    projected[index] = ProjectedSplat(clip, vec4<f32>(clipAxis0, 0.0, 0.0), vec4<f32>(clipAxis1, 0.0, 0.0), vec4<f32>(splat.color.xyz, splat.centerOpacity.w));
    keys[index] = KeyIndex(~bitcast<u32>(viewCenter.z), index);
    atomicAdd(&args.instanceCount, 1u);
}
