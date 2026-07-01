import { randomRange } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { Color4 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/** Serialized `VertexData` carried by a MeshShapeBlock when `serializedCachedData` is set in the editor. */
interface CachedVertexData {
    positions?: number[];
    indices?: number[];
    normals?: number[];
    colors?: number[];
}

/**
 * `MeshShapeBlock` — emits particles from a mesh's surface. The mesh geometry travels in the graph as the
 * block's `cachedVertexData` (positions/indices/normals), which the Node Particle Editor bakes when
 * "serialize cached data" is enabled. Each particle picks a random triangle and a random barycentric point;
 * the direction is the interpolated face normal (`useMeshNormalsForDirection`, the default) or a uniform
 * random between `direction1`/`direction2`. The three raw `Math.random()` draws (face index, then the two
 * barycentric coordinates) mirror BJS `MeshShapeBlock` exactly. A graph with no baked geometry emits nothing,
 * as in BJS. Pure-translation emitter, mesh-local geometry (no world-space transform).
 */
export const meshShapeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;
        ctx.setOutput(block.id, "output", () => system);

        const cached = block.serialized.cachedVertexData as CachedVertexData | undefined;
        const positions = cached?.positions;
        const indices = cached?.indices;
        const normals = cached?.normals;
        const colors = cached?.colors;
        // Without baked geometry there is nothing to sample; BJS early-outs the same way (particles stay put).
        if (!positions || !indices) {
            return;
        }

        const useMeshNormalsForDirection = block.serialized.useMeshNormalsForDirection !== false;
        const useMeshColorForColor = block.serialized.useMeshColorForColor === true;
        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));

        // When the mesh drives colour, the CreateParticle colour slot is suppressed (mirrors BJS clearing
        // `_colorCreation`); the colour is written here from the sampled triangle instead.
        if (useMeshColorForColor && colors) {
            system._createColor = null;
        }

        // Face normal at the sampled point, computed in the position slot and consumed by the direction slot.
        let normalX = 0;
        let normalY = 0;
        let normalZ = 0;

        system._createPosition = (particle, sys) => {
            state.particle = particle;
            state.system = sys;

            const randomFaceIndex = 3 * ((Math.random() * (indices.length / 3)) | 0);
            const bu = Math.random();
            const bv = Math.random() * (1.0 - bu);
            const bw = 1.0 - bu - bv;

            const ia = indices[randomFaceIndex]!;
            const ib = indices[randomFaceIndex + 1]!;
            const ic = indices[randomFaceIndex + 2]!;

            const ax = positions[ia * 3]!;
            const ay = positions[ia * 3 + 1]!;
            const az = positions[ia * 3 + 2]!;
            const bx = positions[ib * 3]!;
            const by = positions[ib * 3 + 1]!;
            const bz = positions[ib * 3 + 2]!;
            const cx = positions[ic * 3]!;
            const cy = positions[ic * 3 + 1]!;
            const cz = positions[ic * 3 + 2]!;

            const rx = bu * ax + bv * bx + bw * cx;
            const ry = bu * ay + bv * by + bw * cy;
            const rz = bu * az + bv * bz + bw * cz;

            if (sys.isLocal) {
                particle.position.x = rx;
                particle.position.y = ry;
                particle.position.z = rz;
            } else {
                particle.position.x = rx + state.emitter.x;
                particle.position.y = ry + state.emitter.y;
                particle.position.z = rz + state.emitter.z;
            }

            if (useMeshNormalsForDirection && normals) {
                normalX = bu * normals[ia * 3]! + bv * normals[ib * 3]! + bw * normals[ic * 3]!;
                normalY = bu * normals[ia * 3 + 1]! + bv * normals[ib * 3 + 1]! + bw * normals[ic * 3 + 1]!;
                normalZ = bu * normals[ia * 3 + 2]! + bv * normals[ib * 3 + 2]! + bw * normals[ic * 3 + 2]!;
            }

            if (useMeshColorForColor && colors) {
                const color = particle.color as Color4;
                color.r = bu * colors[ia * 4]! + bv * colors[ib * 4]! + bw * colors[ic * 4]!;
                color.g = bu * colors[ia * 4 + 1]! + bv * colors[ib * 4 + 1]! + bw * colors[ic * 4 + 1]!;
                color.b = bu * colors[ia * 4 + 2]! + bv * colors[ib * 4 + 2]! + bw * colors[ic * 4 + 2]!;
                color.a = bu * colors[ia * 4 + 3]! + bv * colors[ib * 4 + 3]! + bw * colors[ic * 4 + 3]!;
            }
        };

        system._createDirection = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            if (useMeshNormalsForDirection && normals) {
                particle.direction.x = normalX;
                particle.direction.y = normalY;
                particle.direction.z = normalZ;
                return;
            }
            const dir1 = dir1Getter(state) as Vec3;
            const dir2 = dir2Getter(state) as Vec3;
            const rx = randomRange(dir1.x, dir2.x);
            const ry = randomRange(dir1.y, dir2.y);
            const rz = randomRange(dir1.z, dir2.z);
            particle.direction.x = rx;
            particle.direction.y = ry;
            particle.direction.z = rz;
            particle._initialDirection.x = rx;
            particle._initialDirection.y = ry;
            particle._initialDirection.z = rz;
        };
    },
};
