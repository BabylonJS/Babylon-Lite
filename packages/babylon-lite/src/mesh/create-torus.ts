import { F32, U32 } from "../engine/typed-arrays.js";
/**
 * Torus mesh generator — matches Babylon.js Mesh.CreateTorus exactly.
 *
 * Babylon's parameterization:
 *   R = diameter / 2 (major radius)
 *   r = thickness / 2 (tube radius)
 *   outerAngle = i * 2π / tess - π/2 (around ring, offset by -π/2)
 *   innerAngle = j * 2π / tess + π  (around tube, offset by π)
 *
 *   Local position = (cos(inner)*r, sin(inner)*r, 0)
 *   Then: Translate(R, 0, 0) * RotateY(outerAngle)
 *
 *   Equivalent direct formulas:
 *     x = (cos(inner)*r + R) * cos(outer)
 *     y = sin(inner) * r
 *     z = -(cos(inner)*r + R) * sin(outer)
 */

export interface TorusData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for `createTorusData`. Subset of Babylon's CreateTorus. */
export interface TorusOptions {
    diameter?: number;
    thickness?: number;
    tessellation?: number;
}

export function createTorusData(opts: TorusOptions = {}): TorusData {
    const diameter = opts.diameter ?? 1;
    const thickness = opts.thickness ?? 0.5;
    const tessellation = opts.tessellation ?? 16;

    const R = diameter / 2;
    const r = thickness / 2;
    const stride = tessellation + 1;
    const vertexCount = stride * stride;
    // Babylon generates indices for ALL vertex pairs including wrapping seams
    const indexCount = stride * stride * 6;

    const positions = new F32(vertexCount * 3);
    const normals = new F32(vertexCount * 3);
    const uvs = new F32(vertexCount * 2);
    const indices = new U32(indexCount);

    const TWO_PI = Math.PI * 2;

    let vi = 0;
    let ui = 0;
    let ii = 0;

    for (let i = 0; i <= tessellation; i++) {
        const outerAngle = (i * TWO_PI) / tessellation - Math.PI / 2;
        const cosOuter = Math.cos(outerAngle);
        const sinOuter = Math.sin(outerAngle);

        for (let j = 0; j <= tessellation; j++) {
            const innerAngle = (j * TWO_PI) / tessellation + Math.PI;
            const dx = Math.cos(innerAngle);
            const dy = Math.sin(innerAngle);

            // Position: Translation(R, 0, 0) then RotationY(outerAngle)
            const px = dx * r; // local position x
            const x = (px + R) * cosOuter;
            const y = dy * r;
            const z = -(px + R) * sinOuter;

            positions[vi] = x;
            positions[vi + 1] = y;
            positions[vi + 2] = z;

            // Normal: RotationY(outerAngle) applied to (dx, dy, 0)
            normals[vi] = dx * cosOuter;
            normals[vi + 1] = dy;
            normals[vi + 2] = -dx * sinOuter;

            vi += 3;

            // UV
            uvs[ui] = i / tessellation;
            uvs[ui + 1] = 1 - j / tessellation;
            ui += 2;

            // Indices (with wrapping via modulo)
            const nextI = (i + 1) % stride;
            const nextJ = (j + 1) % stride;

            indices[ii++] = i * stride + j;
            indices[ii++] = i * stride + nextJ;
            indices[ii++] = nextI * stride + j;
            indices[ii++] = i * stride + nextJ;
            indices[ii++] = nextI * stride + nextJ;
            indices[ii++] = nextI * stride + j;
        }
    }

    return { positions, normals, uvs, indices };
}
