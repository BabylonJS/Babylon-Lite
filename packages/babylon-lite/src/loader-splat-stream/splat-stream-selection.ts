import type { FrustumPlane, StreamBound, StreamLeaf, StreamSelection, StreamSelectionInput, StreamSelectionPlan, StreamSource, StreamTreeNode } from "./splat-stream-types.js";

const PREFIX = "[GaussianSplatStream]";

function normalizedPlane(x: number, y: number, z: number, w: number): FrustumPlane {
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length === 0) {
        throw new Error(`${PREFIX} selection: invalid view-projection frustum`);
    }
    return { x: x / length, y: y / length, z: z / length, w: w / length };
}

/** @internal Extracts normalized WebGPU (z in 0..w) frustum planes from a column-major matrix. */
export function extractStreamFrustumPlanes(matrix: ArrayLike<number>): readonly FrustumPlane[] {
    if (matrix.length < 16) {
        throw new Error(`${PREFIX} selection: viewProjectionMatrix must contain 16 values`);
    }
    const m = (index: number): number => {
        const value = matrix[index];
        if (value === undefined || !Number.isFinite(value)) {
            throw new Error(`${PREFIX} selection: viewProjectionMatrix must be finite`);
        }
        return value;
    };
    return [
        normalizedPlane(m(3) + m(0), m(7) + m(4), m(11) + m(8), m(15) + m(12)),
        normalizedPlane(m(3) - m(0), m(7) - m(4), m(11) - m(8), m(15) - m(12)),
        normalizedPlane(m(3) + m(1), m(7) + m(5), m(11) + m(9), m(15) + m(13)),
        normalizedPlane(m(3) - m(1), m(7) - m(5), m(11) - m(9), m(15) - m(13)),
        normalizedPlane(m(2), m(6), m(10), m(14)),
        normalizedPlane(m(3) - m(2), m(7) - m(6), m(11) - m(10), m(15) - m(14)),
    ];
}

/** @internal Conservatively transforms an AABB by an arbitrary affine column-major matrix. */
export function transformStreamBound(bound: StreamBound, matrix: ArrayLike<number>): StreamBound {
    if (matrix.length < 16) {
        throw new Error(`${PREFIX} selection: worldMatrix must contain 16 values`);
    }
    const min = new Float32Array([Infinity, Infinity, Infinity]);
    const max = new Float32Array([-Infinity, -Infinity, -Infinity]);
    for (let corner = 0; corner < 8; corner++) {
        const px = (corner & 1) !== 0 ? bound.boundMax[0]! : bound.boundMin[0]!;
        const py = (corner & 2) !== 0 ? bound.boundMax[1]! : bound.boundMin[1]!;
        const pz = (corner & 4) !== 0 ? bound.boundMax[2]! : bound.boundMin[2]!;
        const tx = matrix[0]! * px + matrix[4]! * py + matrix[8]! * pz + matrix[12]!;
        const ty = matrix[1]! * px + matrix[5]! * py + matrix[9]! * pz + matrix[13]!;
        const tz = matrix[2]! * px + matrix[6]! * py + matrix[10]! * pz + matrix[14]!;
        if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
            throw new Error(`${PREFIX} selection: world transform produced nonfinite bounds`);
        }
        min[0] = Math.min(min[0]!, tx);
        min[1] = Math.min(min[1]!, ty);
        min[2] = Math.min(min[2]!, tz);
        max[0] = Math.max(max[0]!, tx);
        max[1] = Math.max(max[1]!, ty);
        max[2] = Math.max(max[2]!, tz);
    }
    const center = new Float32Array([(min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5]);
    return { boundMin: min, boundMax: max, center, radius: Math.hypot(max[0]! - center[0]!, max[1]! - center[1]!, max[2]! - center[2]!) };
}

function intersectsFrustum(bound: StreamBound, planes: readonly FrustumPlane[]): boolean {
    for (const plane of planes) {
        const x = plane.x >= 0 ? bound.boundMax[0]! : bound.boundMin[0]!;
        const y = plane.y >= 0 ? bound.boundMax[1]! : bound.boundMin[1]!;
        const z = plane.z >= 0 ? bound.boundMax[2]! : bound.boundMin[2]!;
        if (plane.x * x + plane.y * y + plane.z * z + plane.w < 0) {
            return false;
        }
    }
    return true;
}

interface VisibleLeaf {
    leaf: StreamLeaf;
    bound: StreamBound;
}

function collectVisible(node: StreamTreeNode, matrix: ArrayLike<number>, planes: readonly FrustumPlane[], output: VisibleLeaf[]): void {
    const bound = transformStreamBound(node, matrix);
    if (!intersectsFrustum(bound, planes)) {
        return;
    }
    if (node.kind === "leaf") {
        output.push({ leaf: node, bound });
        return;
    }
    for (const child of node.children) {
        collectVisible(child, matrix, planes, output);
    }
}

function nearestDistance(bound: StreamBound, position: ArrayLike<number>): number {
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
        const coordinate = position[axis]!;
        if (!Number.isFinite(coordinate)) {
            throw new Error(`${PREFIX} selection: cameraPosition must be finite`);
        }
        const delta = coordinate < bound.boundMin[axis]! ? bound.boundMin[axis]! - coordinate : coordinate > bound.boundMax[axis]! ? coordinate - bound.boundMax[axis]! : 0;
        squared += delta * delta;
    }
    return Math.sqrt(squared);
}

interface Candidate {
    visible: VisibleLeaf;
    currentIndex: number;
    distanceToCamera: number;
    projectedRadius: number;
}

/** @internal Plans visible leaf alternatives under error, splat-budget, and hysteresis constraints. */
export function planStreamSelection(input: StreamSelectionInput): StreamSelectionPlan {
    if (input.perspective === false) {
        throw new Error(`${PREFIX} selection: orthographic cameras are unsupported`);
    }
    if (
        !Number.isFinite(input.projectionP11) ||
        !Number.isFinite(input.targetHeight) ||
        input.targetHeight <= 0 ||
        !Number.isFinite(input.near) ||
        input.near <= 0 ||
        !Number.isSafeInteger(input.maxSplats) ||
        input.maxSplats <= 0 ||
        !Number.isFinite(input.screenError) ||
        input.screenError <= 0 ||
        !Number.isFinite(input.lodHysteresis) ||
        input.lodHysteresis < 0 ||
        input.lodHysteresis > 1
    ) {
        throw new Error(`${PREFIX} selection: invalid planner parameters`);
    }
    const planes = extractStreamFrustumPlanes(input.viewProjectionMatrix);
    const visible: VisibleLeaf[] = [];
    collectVisible(input.root, input.worldMatrix, planes, visible);
    visible.sort((a, b) => a.leaf.id - b.leaf.id);
    const focalScale = (input.targetHeight * Math.abs(input.projectionP11)) / 2;
    const candidates: Candidate[] = visible.map((entry) => {
        const distanceToCamera = nearestDistance(entry.bound, input.cameraPosition);
        return {
            visible: entry,
            currentIndex: 0,
            distanceToCamera,
            projectedRadius: (focalScale * entry.bound.radius) / Math.max(entry.bound.radius + distanceToCamera, input.near),
        };
    });
    const baselineSplats = candidates.reduce((sum, candidate) => sum + candidate.visible.leaf.alternatives[0]!.count, 0);
    if (baselineSplats > input.maxSplats) {
        throw new Error(`${PREFIX} selection: visible coarse baseline (${baselineSplats} splats) exceeds maxSplats (${input.maxSplats})`);
    }
    let selectedSplats = baselineSplats;

    for (;;) {
        let best: Candidate | null = null;
        let bestDistance = Infinity;
        let bestError = -Infinity;
        let bestAdded = 0;
        for (const candidate of candidates) {
            const alternatives = candidate.visible.leaf.alternatives;
            const current = alternatives[candidate.currentIndex]!;
            const next = alternatives[candidate.currentIndex + 1];
            if (!next) {
                continue;
            }
            const previous = input.previousTargets?.get(candidate.visible.leaf.id);
            const previousIndex = previous
                ? alternatives.findIndex(
                      (representation) => representation.fileId === previous.fileId && representation.offset === previous.offset && representation.count === previous.count
                  )
                : -1;
            const nextIndex = candidate.currentIndex + 1;
            const threshold =
                input.hardBudgetPressure || previousIndex < 0
                    ? input.screenError
                    : nextIndex <= previousIndex
                      ? input.screenError * (1 - input.lodHysteresis)
                      : input.screenError * (1 + input.lodHysteresis);
            const currentError = candidate.projectedRadius * current.error;
            if (currentError <= threshold) {
                continue;
            }
            const added = next.count - current.count;
            if (added <= 0 || selectedSplats + added > input.maxSplats) {
                continue;
            }
            const gain = candidate.projectedRadius * Math.max(0, current.error - next.error);
            if (
                gain > 0 &&
                (candidate.distanceToCamera < bestDistance ||
                    (candidate.distanceToCamera === bestDistance &&
                        (currentError > bestError || (currentError === bestError && candidate.visible.leaf.id < best!.visible.leaf.id))))
            ) {
                best = candidate;
                bestDistance = candidate.distanceToCamera;
                bestError = currentError;
                bestAdded = added;
            }
        }
        if (!best) {
            break;
        }
        best.currentIndex++;
        selectedSplats += bestAdded;
    }

    const selections: StreamSelection[] = candidates.map((candidate) => {
        const target = candidate.visible.leaf.alternatives[candidate.currentIndex]!;
        return { leaf: candidate.visible.leaf, target, projectedError: candidate.projectedRadius * target.error };
    });
    return { selections, visibleLeaves: visible.length, selectedSplats };
}

/** @internal Chooses the coarse bootstrap source by coverage, aggregate cost, then stable file ID. */
export function selectBootstrapSource(leaves: readonly StreamLeaf[], sources: readonly StreamSource[]): StreamSource {
    const coverage = new Uint32Array(sources.length);
    const splats = new Float64Array(sources.length);
    for (const leaf of leaves) {
        const cheapest = leaf.alternatives[0]!;
        coverage[cheapest.fileId] = coverage[cheapest.fileId]! + 1;
        splats[cheapest.fileId] = splats[cheapest.fileId]! + cheapest.count;
    }
    let best: StreamSource | null = null;
    for (const source of sources) {
        if (coverage[source.id] === 0) {
            continue;
        }
        if (
            !best ||
            coverage[source.id]! > coverage[best.id]! ||
            (coverage[source.id] === coverage[best.id] && (splats[source.id]! < splats[best.id]! || (splats[source.id] === splats[best.id] && source.id < best.id)))
        ) {
            best = source;
        }
    }
    if (!best) {
        throw new Error(`${PREFIX} bootstrap: manifest has no positive coarse source`);
    }
    return best;
}
