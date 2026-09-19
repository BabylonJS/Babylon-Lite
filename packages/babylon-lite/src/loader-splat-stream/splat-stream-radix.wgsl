struct KeyIndex {
    key: u32,
    index: u32,
}
struct Params {
    count: u32,
    groups: u32,
    shift: u32,
    blocks: u32,
    stride: u32,
    parentStride: u32,
}
@group(0) @binding(0) var<storage, read> input: array<KeyIndex>;
@group(0) @binding(1) var<storage, read_write> output: array<KeyIndex>;
@group(0) @binding(2) var<storage, read_write> values: array<u32>;
@group(0) @binding(3) var<storage, read_write> scanned: array<u32>;
@group(0) @binding(4) var<storage, read_write> sums: array<u32>;
@group(0) @binding(5) var<storage, read_write> digitBases: array<u32>;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var<storage, read> runtime: array<u32>;
var<workgroup> histogram: array<atomic<u32>, 16>;
var<workgroup> scanData: array<u32, 256>;
var<workgroup> digits: array<u32, 256>;

fn runtimeCount() -> u32 {
    return runtime[0];
}
fn runtimeGroups(level: u32) -> u32 {
    var count = (runtimeCount() + 255u) / 256u;
    for (var index = 0u; index < level; index++) {
        count = (count + 255u) / 256u;
    }
    return count;
}

@compute @workgroup_size(256)
fn histogramMain(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    if (local.x < 16u) {
        atomicStore(&histogram[local.x], 0u);
    }
    workgroupBarrier();
    let index = group.x * 256u + local.x;
    if (index < runtimeCount()) {
        let digit = (input[index].key >> params.shift) & 15u;
        atomicAdd(&histogram[digit], 1u);
    }
    workgroupBarrier();
    if (local.x < 16u) {
        values[local.x * params.stride + group.x] = atomicLoad(&histogram[local.x]);
    }
}

@compute @workgroup_size(256)
fn scanMain(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    let block = group.x;
    let digit = group.y;
    let index = block * 256u + local.x;
    let groups = runtimeGroups(params.groups);
    scanData[local.x] = 0u;
    if (index < groups) {
        scanData[local.x] = values[digit * params.stride + index];
    }
    workgroupBarrier();
    var offset = 1u;
    for (var width = 128u; width > 0u; width >>= 1u) {
        if (local.x < width) {
            let ai = offset * (2u * local.x + 1u) - 1u;
            let bi = offset * (2u * local.x + 2u) - 1u;
            scanData[bi] += scanData[ai];
        }
        offset <<= 1u;
        workgroupBarrier();
    }
    if (local.x == 0u) {
        sums[digit * params.blocks + block] = scanData[255];
        scanData[255] = 0u;
    }
    workgroupBarrier();
    for (var width = 1u; width < 256u; width <<= 1u) {
        offset >>= 1u;
        if (local.x < width) {
            let ai = offset * (2u * local.x + 1u) - 1u;
            let bi = offset * (2u * local.x + 2u) - 1u;
            let temporary = scanData[ai];
            scanData[ai] = scanData[bi];
            scanData[bi] += temporary;
        }
        workgroupBarrier();
    }
    if (index < groups) {
        scanned[digit * params.stride + index] = scanData[local.x];
    }
}

@compute @workgroup_size(256)
fn addMain(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    let digit = id.y;
    let groups = runtimeGroups(params.groups);
    if (index >= groups) {
        return;
    }
    let block = index / 256u;
    scanned[digit * params.stride + index] += values[digit * params.parentStride + block];
}

@compute @workgroup_size(16)
fn basesMain(@builtin(local_invocation_id) local: vec3<u32>) {
    let digit = local.x;
    scanData[digit] = sums[digit * params.blocks];
    workgroupBarrier();
    if (digit == 0u) {
        var total = 0u;
        for (var d = 0u; d < 16u; d++) {
            let value = scanData[d];
            digitBases[d] = total;
            total += value;
        }
    }
}

@compute @workgroup_size(256)
fn scatterMain(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    let index = group.x * 256u + local.x;
    let valid = index < runtimeCount();
    var digit = 16u;
    if (valid) {
        digit = (input[index].key >> params.shift) & 15u;
    }
    digits[local.x] = digit;
    workgroupBarrier();
    if (!valid) {
        return;
    }
    var rank = 0u;
    for (var lane = 0u; lane < local.x; lane++) {
        rank += select(0u, 1u, digits[lane] == digit);
    }
    let destination = digitBases[digit] + scanned[digit * params.stride + group.x] + rank;
    output[destination] = input[index];
}
