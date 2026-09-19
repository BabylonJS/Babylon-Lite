struct KeyIndex {
    key: u32,
    index: u32,
}
struct DrawArgs {
    vertexCount: u32,
    instanceCount: u32,
    firstVertex: u32,
    firstInstance: u32,
}
struct Params {
    count: u32,
    groups: u32,
    blocks: u32,
    stride: u32,
    parentStride: u32,
    levelCount: u32,
}
@group(0) @binding(0) var<storage, read> sparseKeys: array<KeyIndex>;
@group(0) @binding(1) var<storage, read_write> denseKeys: array<KeyIndex>;
@group(0) @binding(2) var<storage, read> inputValues: array<u32>;
@group(0) @binding(3) var<storage, read_write> scanned: array<u32>;
@group(0) @binding(4) var<storage, read_write> sums: array<u32>;
@group(0) @binding(5) var<storage, read> parentScanned: array<u32>;
@group(0) @binding(6) var<storage, read_write> drawArgs: DrawArgs;
@group(0) @binding(7) var<storage, read_write> runtime: array<u32>;
@group(0) @binding(8) var<uniform> params: Params;
var<workgroup> scanData: array<u32, 256>;

fn ceilGroups(count: u32) -> u32 {
    return (count + 255u) / 256u;
}
fn setDispatch(slot: u32, x: u32, y: u32) {
    let base = 4u + slot * 3u;
    runtime[base] = x;
    runtime[base + 1u] = y;
    runtime[base + 2u] = 1u;
}

@compute @workgroup_size(256)
fn scanMain(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    let block = group.x;
    let index = block * 256u + local.x;
    scanData[local.x] = 0u;
    if (index < params.groups) {
        scanData[local.x] = inputValues[index];
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
        sums[block] = scanData[255];
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
    if (index < params.groups) {
        scanned[index] = scanData[local.x];
    }
}

@compute @workgroup_size(256)
fn addMain(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    if (index < params.groups) {
        scanned[index] += parentScanned[index / 256u];
    }
}

@compute @workgroup_size(1)
fn setupMain() {
    let count = sums[0];
    runtime[0] = count;
    drawArgs = DrawArgs(6u, count, 0u, 0u);
    var levelItems = ceilGroups(count);
    setDispatch(0u, levelItems, 1u);
    for (var level = 0u; level < params.levelCount; level++) {
        setDispatch(1u + level, max(1u, ceilGroups(levelItems)), 16u);
        levelItems = ceilGroups(levelItems);
    }
    var childItems = ceilGroups(count);
    for (var child = 0u; child + 1u < params.levelCount; child++) {
        setDispatch(1u + params.levelCount + child, ceilGroups(childItems), 16u);
        childItems = ceilGroups(childItems);
    }
}

@compute @workgroup_size(256)
fn scatterMain(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    if (index < params.count && inputValues[index] != 0u) {
        denseKeys[scanned[index]] = sparseKeys[index];
    }
}
