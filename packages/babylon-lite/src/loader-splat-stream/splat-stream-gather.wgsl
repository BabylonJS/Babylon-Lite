struct CanonicalSplat {
    centerOpacity: vec4<f32>,
    covarianceA: vec4<f32>,
    covarianceB: vec4<f32>,
    color: vec4<f32>,
}
struct GatherParams {
    sourceOffset: u32,
    count: u32,
    destinationOffset: u32,
    width: u32,
    meansMin: vec4<f32>,
    meansMax: vec4<f32>,
}
@group(0) @binding(0) var meansLow: texture_2d<f32>;
@group(0) @binding(1) var meansHigh: texture_2d<f32>;
@group(0) @binding(2) var scales: texture_2d<f32>;
@group(0) @binding(3) var quats: texture_2d<f32>;
@group(0) @binding(4) var sh0: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> codebooks: array<f32>;
@group(0) @binding(6) var<storage, read_write> output: array<CanonicalSplat>;
@group(0) @binding(7) var<uniform> params: GatherParams;

fn bytes(texture: texture_2d<f32>, coord: vec2<i32>) -> vec4<u32> {
    return vec4<u32>(round(textureLoad(texture, coord, 0) * 255.0));
}
fn signedExp(value: f32) -> f32 {
    return sign(value) * (exp(abs(value)) - 1.0);
}
fn quatMatrix(q: vec4<f32>) -> mat3x3<f32> {
    let x2 = q.x + q.x;
    let y2 = q.y + q.y;
    let z2 = q.z + q.z;
    let xx = q.x * x2;
    let xy = q.x * y2;
    let xz = q.x * z2;
    let yy = q.y * y2;
    let yz = q.y * z2;
    let zz = q.z * z2;
    let wx = q.w * x2;
    let wy = q.w * y2;
    let wz = q.w * z2;
    return mat3x3<f32>(
        vec3<f32>(1.0 - yy - zz, xy + wz, xz - wy),
        vec3<f32>(xy - wz, 1.0 - xx - zz, yz + wx),
        vec3<f32>(xz + wy, yz - wx, 1.0 - xx - yy)
    );
}
fn finite3(v: vec3<f32>) -> bool {
    return all(v == v) && all(abs(v) <= vec3<f32>(3.402823e38));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= params.count) {
        return;
    }
    let sourceIndex = params.sourceOffset + id.x;
    let coord = vec2<i32>(i32(sourceIndex % params.width), i32(sourceIndex / params.width));
    let lo = bytes(meansLow, coord);
    let hi = bytes(meansHigh, coord);
    let t = vec3<f32>(lo.xyz + hi.xyz * 256u) / 65535.0;
    let centerSource = vec3<f32>(
        signedExp(mix(params.meansMin.x, params.meansMax.x, t.x)),
        signedExp(mix(params.meansMin.y, params.meansMax.y, t.y)),
        signedExp(mix(params.meansMin.z, params.meansMax.z, t.z))
    );
    let scaleBytes = bytes(scales, coord);
    let scale = vec3<f32>(
        exp(codebooks[scaleBytes.x]),
        exp(codebooks[scaleBytes.y]),
        exp(codebooks[scaleBytes.z])
    );
    let qb = bytes(quats, coord);
    let abc = (vec3<f32>(qb.xyz) / 255.0 - vec3<f32>(0.5)) * sqrt(2.0);
    let d = sqrt(max(0.0, 1.0 - dot(abc, abc)));
    let selector = i32(qb.w) - 252;
    var q = vec4<f32>(0.0);
    if (selector == 0) {
        q = vec4<f32>(abc, d);
    } else if (selector == 1) {
        q = vec4<f32>(d, abc.y, abc.z, abc.x);
    } else if (selector == 2) {
        q = vec4<f32>(abc.y, d, abc.z, abc.x);
    } else if (selector == 3) {
        q = vec4<f32>(abc.y, abc.z, d, abc.x);
    }
    let rotation = quatMatrix(q);
    let m0 = rotation[0] * (2.0 * scale.x);
    let m1 = rotation[1] * (2.0 * scale.y);
    let m2 = rotation[2] * (2.0 * scale.z);
    let c00 = m0.x * m0.x + m1.x * m1.x + m2.x * m2.x;
    let c01 = m0.x * m0.y + m1.x * m1.y + m2.x * m2.y;
    let c02 = -(m0.x * m0.z + m1.x * m1.z + m2.x * m2.z);
    let c11 = m0.y * m0.y + m1.y * m1.y + m2.y * m2.y;
    let c12 = -(m0.y * m0.z + m1.y * m1.z + m2.y * m2.z);
    let c22 = m0.z * m0.z + m1.z * m1.z + m2.z * m2.z;
    let c0 = vec3<f32>(c00, c01, c02);
    let c1 = vec3<f32>(c01, c11, c12);
    let c2 = vec3<f32>(c02, c12, c22);
    let colorBytes = bytes(sh0, coord);
    let color = vec3<f32>(
        0.5 + 0.28209479177387814 * codebooks[256u + colorBytes.x],
        0.5 + 0.28209479177387814 * codebooks[256u + colorBytes.y],
        0.5 + 0.28209479177387814 * codebooks[256u + colorBytes.z]
    );
    let valid = selector >= 0 && selector < 4 && finite3(centerSource) && finite3(scale) && finite3(color) && finite3(c0) && finite3(c1) && finite3(c2);
    let opacity = select(0.0, f32(colorBytes.w) / 255.0, valid);
    output[params.destinationOffset + id.x] = CanonicalSplat(
        vec4<f32>(centerSource.xy, -centerSource.z, opacity),
        vec4<f32>(c0.x, c0.y, c0.z, c1.y),
        vec4<f32>(c1.z, c2.z, 0.0, 0.0),
        vec4<f32>(color, 0.0)
    );
}
