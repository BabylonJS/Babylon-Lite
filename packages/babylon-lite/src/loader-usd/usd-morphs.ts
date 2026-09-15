import type { UsdContext, UsdDraw } from "./usd-context.js";
import { USD_NONE, UsdOp, usdField, usdFloats } from "./usd-protocol.js";

interface SourceTarget {
    id: number;
    vertexCount: number;
    positions: Float32Array;
    normals: Float32Array | null;
    influence: number;
}

function deltas(target: Float32Array, base: Float32Array, draw: UsdDraw): Float32Array {
    const vertexCount = draw.geometry.positions.length / 3;
    const result = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        const source = draw.geometry.vertexMap?.[vertex] ?? vertex;
        for (let component = 0; component < 3; component++) {
            result[vertex * 3 + component] = target[source * 3 + component]! - base[vertex * 3 + component]!;
        }
    }
    return result;
}

/** @internal Convert absolute protocol targets to Lite delta storage buffers. */
export async function apply(context: UsdContext): Promise<void> {
    const byMesh = new Map<number, SourceTarget[]>();
    for (const record of context.records) {
        if (record.op !== UsdOp.MorphTarget) {
            continue;
        }
        const id = usdField(record, 0);
        const meshId = usdField(record, 1);
        const vertexCount = usdField(record, 4);
        const influence = record.payload.getFloat32(28, true);
        if (context.morphTargets.has(id) || !Number.isFinite(influence)) {
            throw new Error(`Invalid or duplicate USD morph target ${id}`);
        }
        const positions = usdFloats(context.data, usdField(record, 5), vertexCount * 3);
        const normalsOffset = usdField(record, 6);
        const normals = normalsOffset === USD_NONE ? null : usdFloats(context.data, normalsOffset, vertexCount * 3);
        if (!vertexCount || !positions.every(Number.isFinite) || (normals && !normals.every(Number.isFinite))) {
            throw new Error(`USD morph target ${id} contains invalid vertex data`);
        }
        const targets = byMesh.get(meshId) ?? [];
        targets.push({ id, vertexCount, positions, normals, influence });
        byMesh.set(meshId, targets);
    }
    if (!byMesh.size) {
        return;
    }
    const { createMorphTargets } = await import("../morph/create-morph-targets.js");
    for (const [meshId, targets] of byMesh) {
        const draws = context.sources.get(meshId);
        if (!draws) {
            throw new Error(`USD morph targets reference missing mesh ${meshId}`);
        }
        for (const draw of draws) {
            const sourceVertexCount = usdField(draw.geometry.record!, 1);
            if (targets.some((target) => target.vertexCount !== sourceVertexCount)) {
                throw new Error(`USD morph target vertex count does not match mesh ${meshId}`);
            }
            const runtimeTargets = targets.map((target) => ({
                positions: deltas(target.positions, draw.geometry.positions, draw),
                normals: target.normals ? deltas(target.normals, draw.geometry.normals, draw) : null,
            }));
            const data = createMorphTargets(
                context.engine,
                runtimeTargets,
                draw.geometry.positions.length / 3,
                targets.map((target) => target.influence)
            );
            draw.mesh.morphTargets = data;
            targets.forEach((target, targetIndex) => {
                const bindings = context.morphTargets.get(target.id) ?? [];
                bindings.push({ data, targetIndex });
                context.morphTargets.set(target.id, bindings);
            });
        }
    }
}
