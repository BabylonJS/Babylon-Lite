/**
 * Antigravity Racer — CPU ribbon engine trail.
 *
 * Each ship drags a short glowing ribbon behind it. Instead of the original's
 * float-texture-driven node-material trail (unsupported in Lite), this keeps a
 * small ring buffer of recent (position, up, intensity) samples on the CPU and
 * rebuilds a thin ribbon strip from it every tick — cheap at this vertex count
 * (a few dozen points) and works with Lite's plain vertex-buffer mesh API.
 */

import type { EngineContext, Mesh, Vec3 } from "babylon-lite";
import { createMeshFromData, createStandardMaterial, crossVec3, lengthVec3, normalizeVec3Object, scaleVec3, subVec3, updateMeshPositions } from "babylon-lite";

const TRAIL_POINTS = 36;

export interface ShipTrail {
    readonly mesh: Mesh;
    /** Append the newest sample (ship tail position, its current up vector, and 0..1 speed intensity). */
    push(pos: Vec3, up: Vec3, intensity: number): void;
}

export function createShipTrail(engine: EngineContext, color: [number, number, number], startPos: Vec3): ShipTrail {
    const samples: { pos: Vec3; up: Vec3; intensity: number }[] = [];
    for (let i = 0; i < TRAIL_POINTS; i++) {
        samples.push({ pos: { ...startPos }, up: { x: 0, y: 1, z: 0 }, intensity: 0 });
    }

    const vertCount = TRAIL_POINTS * 2;
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const indices = new Uint32Array((TRAIL_POINTS - 1) * 6);
    let ii = 0;
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
        const a = i * 2,
            b = i * 2 + 1,
            c = (i + 1) * 2,
            d = (i + 1) * 2 + 1;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = d;
    }
    // Normals point "up" world-ish; the material is unlit so these are never sampled for shading.
    for (let i = 0; i < vertCount; i++) {
        normals[i * 3 + 1] = 1;
    }

    const mesh = createMeshFromData(engine, "ship-trail", positions, normals, indices, uvs);
    const material = createStandardMaterial();
    material.diffuseColor = [0, 0, 0];
    material.emissiveColor = color;
    material.alpha = 0.5;
    material.disableLighting = true;
    material.backFaceCulling = false;
    mesh.material = material;

    function rebuild(): void {
        for (let i = 0; i < TRAIL_POINTS; i++) {
            const s = samples[i]!;
            const prev = samples[Math.max(0, i - 1)]!.pos;
            const next = samples[Math.min(TRAIL_POINTS - 1, i + 1)]!.pos;
            let tangent = subVec3(next, prev);
            if (lengthVec3(tangent) < 1e-5) {
                tangent = { x: 0, y: 0, z: 1 };
            } else {
                tangent = normalizeVec3Object(tangent);
            }
            let right = crossVec3(tangent, s.up);
            right = lengthVec3(right) < 1e-5 ? { x: 1, y: 0, z: 0 } : normalizeVec3Object(right);
            const width = 0.04 + 0.16 * s.intensity;
            const off = scaleVec3(right, width);
            const li = i * 2;
            const ri = i * 2 + 1;
            positions[li * 3] = s.pos.x + off.x;
            positions[li * 3 + 1] = s.pos.y + off.y;
            positions[li * 3 + 2] = s.pos.z + off.z;
            positions[ri * 3] = s.pos.x - off.x;
            positions[ri * 3 + 1] = s.pos.y - off.y;
            positions[ri * 3 + 2] = s.pos.z - off.z;
            const v = i / (TRAIL_POINTS - 1);
            uvs[li * 2] = 0;
            uvs[li * 2 + 1] = v;
            uvs[ri * 2] = 1;
            uvs[ri * 2 + 1] = v;
        }
        updateMeshPositions(engine, mesh, positions);
    }
    rebuild();

    return {
        mesh,
        push(pos: Vec3, up: Vec3, intensity: number): void {
            samples.shift();
            samples.push({ pos: { ...pos }, up: { ...up }, intensity });
            rebuild();
        },
    };
}
