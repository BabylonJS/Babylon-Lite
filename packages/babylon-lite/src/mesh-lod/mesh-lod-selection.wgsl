// MeshLoD GPU selection + demand compute (architecture §12.3). Mirrors the
// deterministic `runMeshLoDGpuSelection` TS model statement-for-statement over the
// same packed buffers, so the CPU oracle, the Node GPU model, and this shader make
// identical float32 decisions. Reset is done with clearBuffer on the host; this
// module provides the ordered dispatches: traverse -> evaluateGroups ->
// selectClusters -> computeDemand -> (Task 5.3) expandClusters. Workgroup size 64.
//
// One immutable "metaBuf" buffer concatenates nodes ++ groups ++ clusters ++ pageRefs
// (word offsets in params) to stay within the 8-storage-buffer limit; a single u32
// per (group,instance) "groupState" carries visible/fine/resident/demanded bits, and
// one "control" buffer holds the indirect dispatch count, diagnostics, and per-page
// demand accumulators.

struct Params {
  frustum: array<vec4<f32>, 6>,
  cameraPos: vec4<f32>,        // xyz, w = near
  targetInfo: vec4<f32>,       // targetWidth, targetHeight, pixelScale, orthographicHeight
  thresholds: vec4<f32>,       // default screenSpaceError, refineMultiplier, coarsenMultiplier, planeCount
  counts: vec4<u32>,           // instanceCount, groupCount, clusterCount, nodeCount
  layout0: vec4<u32>,          // wordsPerInstance, selectedCapacity, pageCount, levelCount
  offsets: vec4<u32>,          // nodeWordOffset, groupWordOffset, clusterWordOffset, pageRefWordOffset
  control: vec4<u32>,          // diagWordOffset, pageDemandWordOffset, drawCapacity, coneCull
  execution: vec4<u32>,        // debug mode, max workgroups/dimension, page-use offset, reserved
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> metaBuf: array<u32>;
@group(0) @binding(2) var<storage, read> pageState: array<u32>;
@group(0) @binding(3) var<storage, read> instances: array<f32>;
@group(0) @binding(4) var<storage, read_write> priorState: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> groupState: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> selectedList: array<u32>;
@group(0) @binding(7) var<storage, read_write> control: array<atomic<u32>>;

const INSTANCE_WORDS: u32 = 32u;
const NODE_WORDS: u32 = 8u;
const GROUP_WORDS: u32 = 16u;
const CLUSTER_WORDS: u32 = 16u;
const PAGE_STATE_WORDS: u32 = 8u;

const GS_VISIBLE: u32 = 0x1u;
const GS_FINE: u32 = 0x2u;
const GS_RESIDENT: u32 = 0x4u;
const GS_DEMANDED: u32 = 0x8u;

const PAGE_FLAG_RESIDENT: u32 = 0x1u;
const FIXED_SCALE: f32 = 256.0; // fixed-point scale for atomic priority accumulation

fn metaF32(i: u32) -> f32 { return bitcast<f32>(metaBuf[i]); }

fn groupStateIndex(inst: u32, group: u32) -> u32 { return inst * params.counts.y + group; }
fn priorIndex(inst: u32, group: u32) -> u32 { return inst * params.layout0.x + (group >> 5u); }

fn instMat(iBase: u32, col: u32, row: u32) -> f32 { return instances[iBase + col * 4u + row]; }

// Project a primitive-local sphere by the instance world matrix + camera. Mirrors
// `projectSphere` in mesh-lod-selection-math.ts (perspective + orthographic).
struct Projected { worldCenter: vec3<f32>, worldRadius: f32, errorPx: f32, projectedRadiusPx: f32 };
fn projectSphere(iBase: u32, worldScale: f32, center: vec3<f32>, radius: f32, error: f32) -> Projected {
  let m0 = vec3<f32>(instMat(iBase, 0u, 0u), instMat(iBase, 0u, 1u), instMat(iBase, 0u, 2u));
  let m1 = vec3<f32>(instMat(iBase, 1u, 0u), instMat(iBase, 1u, 1u), instMat(iBase, 1u, 2u));
  let m2 = vec3<f32>(instMat(iBase, 2u, 0u), instMat(iBase, 2u, 1u), instMat(iBase, 2u, 2u));
  let t = vec3<f32>(instMat(iBase, 3u, 0u), instMat(iBase, 3u, 1u), instMat(iBase, 3u, 2u));
  let world = m0 * center.x + m1 * center.y + m2 * center.z + t;
  let worldRadius = radius * worldScale;
  let worldError = error * worldScale;
  let d = params.cameraPos.xyz - world;
  let distance = sqrt(dot(d, d));
  let surfaceDistance = max(distance - worldRadius, params.cameraPos.w);
  let orthoHeight = params.targetInfo.w;
  var errorPx: f32;
  var projectedRadiusPx: f32;
  if (orthoHeight > 0.0) {
    let scale = params.targetInfo.y / orthoHeight;
    errorPx = worldError * scale;
    projectedRadiusPx = worldRadius * scale;
  } else {
    let pixelScale = params.targetInfo.z;
    errorPx = worldError * pixelScale / surfaceDistance;
    projectedRadiusPx = worldRadius * pixelScale / surfaceDistance;
  }
  return Projected(world, worldRadius, errorPx, projectedRadiusPx);
}

fn sphereOutside(center: vec3<f32>, radius: f32) -> bool {
  let planeCount = u32(params.thresholds.w);
  for (var i = 0u; i < planeCount; i = i + 1u) {
    let p = params.frustum[i];
    if (dot(p.xyz, center) + p.w < -radius) { return true; }
  }
  return false;
}

fn pageResident(pageId: u32) -> bool {
  return (pageState[pageId * PAGE_STATE_WORDS] & PAGE_FLAG_RESIDENT) != 0u;
}

fn groupPagesResident(firstPageRef: u32, pageRefCount: u32) -> bool {
  let refBase = params.offsets.w;
  for (var i = 0u; i < pageRefCount; i = i + 1u) {
    if (!pageResident(metaBuf[refBase + firstPageRef + i])) { return false; }
  }
  return true;
}

fn unpackSnorm8(packed: u32, shift: u32) -> f32 {
  let byte = i32((packed >> shift) & 0xffu);
  return f32(select(byte, byte - 256, byte >= 128)) / 127.0;
}

// Positive means potentially visible; <= 0 satisfies meshoptimizer's conservative
// perspective backface test. Disabled for double-sided materials, orthographic
// projection, non-similarity transforms, and clusters without a useful cone.
fn coneCullMargin(iBase: u32, cBase: u32) -> f32 {
  if (params.control.w == 0u || params.targetInfo.w > 0.0 ||
      bitcast<u32>(instances[iBase + 31u]) == 0u || metaBuf[cBase + 15u] == 0u) {
    return 1.0;
  }
  let packed = metaBuf[cBase + 13u];
  let localAxis = vec3<f32>(unpackSnorm8(packed, 0u), unpackSnorm8(packed, 8u), unpackSnorm8(packed, 16u));
  let n0 = vec3<f32>(instances[iBase + 16u], instances[iBase + 17u], instances[iBase + 18u]);
  let n1 = vec3<f32>(instances[iBase + 20u], instances[iBase + 21u], instances[iBase + 22u]);
  let n2 = vec3<f32>(instances[iBase + 24u], instances[iBase + 25u], instances[iBase + 26u]);
  let axis = normalize((n0 * localAxis.x + n1 * localAxis.y + n2 * localAxis.z) * instances[iBase + 23u]);
  let center = vec3<f32>(metaF32(cBase), metaF32(cBase + 1u), metaF32(cBase + 2u));
  let p = projectSphere(iBase, instances[iBase + 28u], center, metaF32(cBase + 3u), 0.0);
  let view = p.worldCenter - params.cameraPos.xyz;
  let distance = length(view);
  let threshold = metaF32(cBase + 14u) * distance + p.worldRadius;
  return (threshold - dot(view, axis)) / max(distance, 1.0e-20);
}

fn invocationIndex(gid: vec3<u32>, dimensions: vec3<u32>) -> u32 {
  return gid.x + (gid.y + gid.z * dimensions.y) * dimensions.x * 64u;
}

// ── 1. Hierarchy visibility: one invocation per (node, instance). Under conservative
//    bounds a not-outside leaf's ancestors are all not-outside, so the per-leaf test
//    equals the root-down traversal the CPU oracle performs. ──
@compute @workgroup_size(64)
fn traverse(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) dimensions: vec3<u32>) {
  let invocation = invocationIndex(gid, dimensions);
  let total = params.counts.w * params.counts.x; // nodeCount * instanceCount
  if (invocation >= total) { return; }
  let node = invocation % params.counts.w;
  let inst = invocation / params.counts.w;
  let iBase = inst * INSTANCE_WORDS;
  if (bitcast<u32>(instances[iBase + 29u]) == 0u) { return; } // invisible
  let nBase = params.offsets.x + node * NODE_WORDS;
  let groupId = i32(metaBuf[nBase + 5u]);
  if (groupId < 0) { return; } // internal node
  let center = vec3<f32>(metaF32(nBase), metaF32(nBase + 1u), metaF32(nBase + 2u));
  let worldScale = instances[iBase + 28u];
  let p = projectSphere(iBase, worldScale, center, metaF32(nBase + 3u), metaF32(nBase + 4u));
  if (!sphereOutside(p.worldCenter, p.worldRadius)) {
    atomicOr(&groupState[groupStateIndex(inst, u32(groupId))], GS_VISIBLE);
  }
}

// ── 2. Group evaluation: one invocation per (group, instance). Residency, hysteretic
//    fine-required decision (asymmetric equality), prior-state persist, diagnostics. ──
@compute @workgroup_size(64)
fn evaluateGroups(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) dimensions: vec3<u32>) {
  let invocation = invocationIndex(gid, dimensions);
  let total = params.counts.y * params.counts.x; // groupCount * instanceCount
  if (invocation >= total) { return; }
  let group = invocation % params.counts.y;
  let inst = invocation / params.counts.y;
  let iBase = inst * INSTANCE_WORDS;
  if (bitcast<u32>(instances[iBase + 29u]) == 0u) { return; }
  let sse = select(params.thresholds.x, instances[iBase + 19u], instances[iBase + 19u] > 0.0);
  let gBase = params.offsets.y + group * GROUP_WORDS;
  let gsIdx = groupStateIndex(inst, group);

  let resident = groupPagesResident(metaBuf[gBase + 8u], metaBuf[gBase + 9u]);
  if (resident) { atomicOr(&groupState[gsIdx], GS_RESIDENT); }

  let terminal = (metaBuf[gBase + 10u] & 0x1u) != 0u;
  let simplifiedError = metaF32(gBase + 4u);
  var fine: bool;
  let pIdx = priorIndex(inst, group);
  let mask = 1u << (group & 31u);
  if (terminal || !(simplifiedError == simplifiedError) || simplifiedError > 3.0e38) {
    fine = true;
  } else {
    let center = vec3<f32>(metaF32(gBase), metaF32(gBase + 1u), metaF32(gBase + 2u));
    let worldScale = instances[iBase + 28u];
    let errorPx = projectSphere(iBase, worldScale, center, metaF32(gBase + 3u), simplifiedError).errorPx;
    let wasFine = (atomicLoad(&priorState[pIdx]) & mask) != 0u;
    if (wasFine) { fine = errorPx >= sse * params.thresholds.z; }
    else { fine = errorPx > sse * params.thresholds.y; }
  }
  if (fine) {
    atomicOr(&groupState[gsIdx], GS_FINE);
    atomicOr(&priorState[pIdx], mask);
  } else {
    atomicAnd(&priorState[pIdx], ~mask);
  }
  if ((atomicLoad(&groupState[gsIdx]) & GS_VISIBLE) != 0u) {
    atomicAdd(&control[params.control.x], 1u); // visibleGroupCount diag
  }
}

// ── 3. Cluster selection: one invocation per (cluster, instance). Preserve the
//    hierarchy-visible group as an atomic crack-free cut, then append
//    (cluster, instance). A second cluster-sphere cull can disagree with the
//    conservative group bounds and punch view-dependent holes. ──
@compute @workgroup_size(64)
fn selectClusters(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) dimensions: vec3<u32>) {
  let invocation = invocationIndex(gid, dimensions);
  let total = params.counts.z * params.counts.x; // clusterCount * instanceCount
  if (invocation >= total) { return; }
  let cluster = invocation % params.counts.z;
  let inst = invocation / params.counts.z;
  let iBase = inst * INSTANCE_WORDS;
  if (bitcast<u32>(instances[iBase + 29u]) == 0u) { return; }
  let cBase = params.offsets.z + cluster * CLUSTER_WORDS;
  let g = metaBuf[cBase + 5u];
  let gs = atomicLoad(&groupState[groupStateIndex(inst, g)]);
  if ((gs & GS_VISIBLE) == 0u || (gs & GS_RESIDENT) == 0u || (gs & GS_FINE) == 0u) { return; }
  let r = i32(metaBuf[cBase + 6u]);
  if (r >= 0) {
    let rs = atomicLoad(&groupState[groupStateIndex(inst, u32(r))]);
    if ((rs & GS_FINE) != 0u && (rs & GS_RESIDENT) != 0u) { return; } // finer group draws instead
  }
  if (coneCullMargin(iBase, cBase) <= 0.0) { return; }
  let idx = atomicAdd(&control[0], 1u); // reserve; control[0] doubles as indirect X
  if (idx < params.layout0.y) {
    selectedList[1u + idx * 2u] = cluster;
    selectedList[2u + idx * 2u] = inst;
    let pageId = metaBuf[cBase + 7u];
    atomicOr(&control[params.execution.z + (pageId >> 5u)], 1u << (pageId & 31u));
    let triangles = metaBuf[cBase + 11u];
    let previous = atomicAdd(&control[params.control.x + 1u], triangles);
    let triangleCap = params.control.z / 3u;
    if (triangles > triangleCap || previous > triangleCap - min(triangles, triangleCap)) {
      atomicOr(&control[params.control.x + 2u], 2u); // selected cut exceeds the draw buffer
    }
    let gBase = params.offsets.y + g * GROUP_WORDS;
    let simplifiedError = metaF32(gBase + 4u);
    if (simplifiedError >= 0.0 && simplifiedError <= 3.0e38) {
      let center = vec3<f32>(metaF32(gBase), metaF32(gBase + 1u), metaF32(gBase + 2u));
      let errorPx = projectSphere(iBase, instances[iBase + 28u], center, metaF32(gBase + 3u), simplifiedError).errorPx;
      if (errorPx >= 0.0 && errorPx <= 3.0e38) {
        atomicMax(&control[params.control.x + 4u], bitcast<u32>(errorPx)); // selected SSE maximum
      }
    }
  } else {
    atomicOr(&control[params.control.x + 2u], 1u); // overflow flag
  }
  // Mark a wanted-but-missing finer group so computeDemand accumulates its priority.
  if (r >= 0) {
    let rs = atomicLoad(&groupState[groupStateIndex(inst, u32(r))]);
    if ((rs & GS_FINE) != 0u && (rs & GS_RESIDENT) == 0u) {
      atomicOr(&groupState[groupStateIndex(inst, u32(r))], GS_DEMANDED);
    }
  }
}

// ── 4. Page demand: one invocation per (group, instance). Visible demanded groups
//    accumulate per-page benefit/cost priority for streaming readback (§11.1). ──
@compute @workgroup_size(64)
fn computeDemand(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) dimensions: vec3<u32>) {
  let invocation = invocationIndex(gid, dimensions);
  let total = params.counts.y * params.counts.x;
  if (invocation >= total) { return; }
  let group = invocation % params.counts.y;
  let inst = invocation / params.counts.y;
  let iBase = inst * INSTANCE_WORDS;
  if (bitcast<u32>(instances[iBase + 29u]) == 0u) { return; }
  let gsIdx = groupStateIndex(inst, group);
  if ((atomicLoad(&groupState[gsIdx]) & GS_DEMANDED) == 0u) { return; }
  let gBase = params.offsets.y + group * GROUP_WORDS;
  let firstPageRef = metaBuf[gBase + 8u];
  let pageRefCount = metaBuf[gBase + 9u];
  var missing = 0u;
  for (var i = 0u; i < pageRefCount; i = i + 1u) {
    if (!pageResident(metaBuf[params.offsets.w + firstPageRef + i])) { missing = missing + 1u; }
  }
  if (missing == 0u) { return; }
  let center = vec3<f32>(metaF32(gBase), metaF32(gBase + 1u), metaF32(gBase + 2u));
  let worldScale = instances[iBase + 28u];
  let p = projectSphere(iBase, worldScale, center, metaF32(gBase + 3u), metaF32(gBase + 4u));
  let areaCap = params.targetInfo.x * params.targetInfo.y;
  let projectedAreaPx = min(3.14159265358979323846 * p.projectedRadiusPx * p.projectedRadiusPx, areaCap);
  let sse = select(params.thresholds.x, instances[iBase + 19u], instances[iBase + 19u] > 0.0);
  let qualityPressure = max(0.0, p.errorPx / sse - 1.0);
  let groupBenefit = projectedAreaPx * qualityPressure;
  let pageShare = groupBenefit / f32(missing);
  let demandBase = params.control.y;
  for (var i = 0u; i < pageRefCount; i = i + 1u) {
    let pageId = metaBuf[params.offsets.w + firstPageRef + i];
    if (!pageResident(pageId)) {
      atomicAdd(&control[demandBase + pageId], u32(pageShare * FIXED_SCALE));
    }
  }
  atomicAdd(&control[params.control.x + 3u], 1u); // fallbackGroupCount diag
  if (p.errorPx >= 0.0) {
    atomicMax(&control[params.control.x + 5u], bitcast<u32>(p.errorPx)); // unmet SSE maximum
  }
}

// ── Task 5.3 clamp — 1 invocation. Runs at the end of the SELECTION pass so the
//    expansion dispatch (a separate pass) skips the entire cut on overflow.
//    Splitting the passes is required: a buffer cannot be writable storage and an
//    indirect-dispatch source in the same synchronization scope. ──
@compute @workgroup_size(1)
fn clampSelectedCount() {
  let c = atomicLoad(&control[0]);
  let cap = params.layout0.y;
  if (c > cap) {
    atomicOr(&control[params.control.x + 2u], 1u); // selection overflow diag
  }
  if (atomicLoad(&control[params.control.x + 2u]) != 0u) {
    atomicStore(&control[0], 0u); // never expand a partial cut
  }
  let count = atomicLoad(&control[0]);
  selectedList[0] = count;
  let x = min(count, params.execution.y);
  let rows = (count + max(x, 1u) - 1u) / max(x, 1u);
  let y = max(min(rows, params.execution.y), 1u);
  let z = max((rows + y - 1u) / y, 1u);
  atomicStore(&control[1], x);
  atomicStore(&control[2], y);
  atomicStore(&control[3], z);
}

// ── Task 5.3 expansion — its own bind-group layout {0,1,2,6,8,9,10} (no `control`,
//    which is the indirect-dispatch source in this pass). One workgroup per selected
//    cluster (the dispatch launches only when the entire cut fits, so every
//    workgroup is active) reserves triangleCount*3 draw vertices atomically, then all
//    lanes decode packed u16 local indices in the geometry arena into absolute vertex-
//    word offsets and 16-byte draw-vertex records. No vertex/index buffer is bound. ──
@group(0) @binding(8) var<storage, read> arena: array<u32>;
@group(0) @binding(9) var<storage, read_write> drawVertices: array<u32>;
@group(0) @binding(10) var<storage, read_write> drawArgs: array<atomic<u32>>;

const VERTEX_WORDS: u32 = 6u; // 24-byte packed vertex / 4

var<workgroup> wgBase: u32;

fn readLocalIndex(byteOffset: u32) -> u32 {
  let word = arena[byteOffset >> 2u];
  let shift = (byteOffset & 2u) * 8u;
  return (word >> shift) & 0xffffu;
}

@compute @workgroup_size(64)
fn expandClusters(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) dimensions: vec3<u32>) {
  let selected = wid.x + (wid.y + wid.z * dimensions.y) * dimensions.x;
  let pair = min(selected, selectedList[0] - 1u);
  let clusterId = selectedList[1u + pair * 2u];
  let slot = selectedList[2u + pair * 2u];
  let cBase = params.offsets.z + clusterId * CLUSTER_WORDS;
  let pageId = metaBuf[cBase + 7u];
  let clusterIndexOffset = metaBuf[cBase + 9u]; // first local index (u16 elements)
  let indexCount = select(0u, metaBuf[cBase + 11u] * 3u, selected < selectedList[0]);
  let psBase = pageId * PAGE_STATE_WORDS;
  let arenaVertexWord = pageState[psBase + 2u] >> 2u; // absolute vertex byte -> word
  let arenaIndexByte = pageState[psBase + 3u];
  let drawCapacity = params.control.z;
  let groupId = metaBuf[cBase + 5u];
  let gBase = params.offsets.y + groupId * GROUP_WORDS;
  var debug = 0u;
  switch params.execution.x {
    case 2u: { debug = metaBuf[gBase + 5u]; }
    case 3u: { debug = groupId; }
    case 4u: {
      let flags = pageState[psBase];
      debug = select(select(0u, 1u, (flags & 1u) != 0u), 2u, (flags & 2u) != 0u);
      debug = select(debug, 3u, (flags & 4u) != 0u);
    }
    case 5u: { debug = pageState[psBase + 7u]; }
    case 6u: { debug = bitcast<u32>(coneCullMargin(slot * INSTANCE_WORDS, cBase)); }
    default: {}
  }
  if (lid.x == 0u) { wgBase = atomicAdd(&drawArgs[0], indexCount); }
  workgroupBarrier();
  let base = wgBase;
  for (var k = lid.x; k < indexCount; k = k + 64u) {
    let dst = base + k;
    if (dst >= drawCapacity) { continue; } // capacity guard: never write OOB
    let localVertex = readLocalIndex(arenaIndexByte + (clusterIndexOffset + k) * 2u);
    let o = dst * 4u;
    drawVertices[o] = arenaVertexWord + localVertex * VERTEX_WORDS;
    drawVertices[o + 1u] = clusterId;
    drawVertices[o + 2u] = slot;
    drawVertices[o + 3u] = debug; // observational; never affects selection or residency
  }
}

// Finalize the indirect draw: suppress the entire cut if expansion somehow exceeds
// capacity (flagged in drawArgs word 4, not control, which is indirect-only here).
@compute @workgroup_size(1)
fn finalizeDraw() {
  let cap = params.control.z;
  let v = atomicLoad(&drawArgs[0]);
  if (v > cap) {
    atomicStore(&drawArgs[0], 0u);
    atomicStore(&drawArgs[4], 1u); // expansion overflow diag
  }
  atomicStore(&drawArgs[1], 1u); // instanceCount
}
