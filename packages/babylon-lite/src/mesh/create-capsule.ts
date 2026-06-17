import { F32, U32 } from "../engine/typed-arrays.js";
/**
 * CreateCapsule — matches Babylon.js MeshBuilder.CreateCapsule default options.
 *
 * Generates a capsule (a cylinder capped by two hemispheres) or a "pill" when
 * `radiusTop`/`radiusBottom` differ. Vertex/normal/UV generation and index
 * winding are ported verbatim from `@babylonjs/core/Meshes/Builders/capsuleBuilder.js`
 * to guarantee parity. The default Y-up orientation is used (the `orientation`
 * remap of the Babylon builder is intentionally omitted to keep the API small).
 */

/** Geometry buffers produced by {@link createCapsuleData}. */
export interface CapsuleData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for `createCapsuleData`. Subset of Babylon's CreateCapsule. */
export interface CapsuleOptions {
    /** Total height of the capsule including both caps. Default 1. */
    height?: number;
    /** Radius of the cylindrical body and both caps. Default 0.25. */
    radius?: number;
    /** Radius of the top cap; defaults to `radius`. */
    radiusTop?: number;
    /** Radius of the bottom cap; defaults to `radius`. */
    radiusBottom?: number;
    /** Number of radial segments around the capsule. Default 16. */
    tessellation?: number;
    /** Number of height segments along the cylindrical body. Default 2. */
    subdivisions?: number;
    /** Number of segments per cap; defaults applied to both caps. Default 6. */
    capSubdivisions?: number;
    /** Number of segments for the top cap; defaults to `capSubdivisions`. */
    topCapSubdivisions?: number;
    /** Number of segments for the bottom cap; defaults to `capSubdivisions`. */
    bottomCapSubdivisions?: number;
}

/**
 * Build capsule geometry data.
 * @param options - Capsule dimensions and tessellation.
 * @returns Positions, normals, UVs, and indices for the capsule mesh.
 */
export function createCapsuleData(options: CapsuleOptions = {}): CapsuleData {
    const subdivisions = Math.max(options.subdivisions ? options.subdivisions : 2, 1) | 0;
    const tessellation = Math.max(options.tessellation ? options.tessellation : 16, 3) | 0;
    const height = Math.max(options.height ? options.height : 1, 0);
    const radius = Math.max(options.radius ? options.radius : 0.25, 0);
    const capDetail = Math.max(options.capSubdivisions ? options.capSubdivisions : 6, 1) | 0;
    const radialSegments = tessellation;
    const heightSegments = subdivisions;
    const radiusTop = Math.max(options.radiusTop ? options.radiusTop : radius, 0);
    const radiusBottom = Math.max(options.radiusBottom ? options.radiusBottom : radius, 0);
    const heightMinusCaps = height - (radiusTop + radiusBottom);
    const thetaStart = 0.0;
    const thetaLength = 2.0 * Math.PI;
    const capsTopSegments = Math.max(options.topCapSubdivisions ? options.topCapSubdivisions : capDetail, 1);
    const capsBottomSegments = Math.max(options.bottomCapSubdivisions ? options.bottomCapSubdivisions : capDetail, 1);
    const alpha = Math.acos((radiusBottom - radiusTop) / height);

    let indices: number[] = [];
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    let index = 0;
    const indexArray: number[][] = [];
    const halfHeight = heightMinusCaps * 0.5;
    const pi2 = Math.PI * 0.5;
    let x: number;
    let y: number;
    const cosAlpha = Math.cos(alpha);
    const sinAlpha = Math.sin(alpha);

    const coneLengthX = radiusTop * sinAlpha - radiusBottom * sinAlpha;
    const coneLengthY = halfHeight + radiusTop * cosAlpha - (-halfHeight + radiusBottom * cosAlpha);
    const coneLength = Math.sqrt(coneLengthX * coneLengthX + coneLengthY * coneLengthY);

    // Total length for the v texture coordinate.
    const vl = radiusTop * alpha + coneLength + radiusBottom * (pi2 - alpha);
    let v = 0;

    // Top cap.
    for (y = 0; y <= capsTopSegments; y++) {
        const indexRow: number[] = [];
        const a = pi2 - alpha * (y / capsTopSegments);
        v += (radiusTop * alpha) / capsTopSegments;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        const ringRadius = cosA * radiusTop;
        for (x = 0; x <= radialSegments; x++) {
            const u = x / radialSegments;
            const theta = u * thetaLength + thetaStart;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
            vertices.push(ringRadius * sinTheta, halfHeight + sinA * radiusTop, ringRadius * cosTheta);
            normals.push(cosA * sinTheta, sinA, cosA * cosTheta);
            uvs.push(u, 1 - v / vl);
            indexRow.push(index);
            index++;
        }
        indexArray.push(indexRow);
    }

    // Cylindrical body.
    const coneHeight = height - radiusTop - radiusBottom + cosAlpha * radiusTop - cosAlpha * radiusBottom;
    const slope = (sinAlpha * (radiusBottom - radiusTop)) / coneHeight;
    for (y = 1; y <= heightSegments; y++) {
        const indexRow: number[] = [];
        v += coneLength / heightSegments;
        const ringRadius = sinAlpha * ((y * (radiusBottom - radiusTop)) / heightSegments + radiusTop);
        for (x = 0; x <= radialSegments; x++) {
            const u = x / radialSegments;
            const theta = u * thetaLength + thetaStart;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
            vertices.push(ringRadius * sinTheta, halfHeight + cosAlpha * radiusTop - (y * coneHeight) / heightSegments, ringRadius * cosTheta);
            const inv = 1 / Math.sqrt(sinTheta * sinTheta + slope * slope + cosTheta * cosTheta);
            normals.push(sinTheta * inv, slope * inv, cosTheta * inv);
            uvs.push(u, 1 - v / vl);
            indexRow.push(index);
            index++;
        }
        indexArray.push(indexRow);
    }

    // Bottom cap.
    for (y = 1; y <= capsBottomSegments; y++) {
        const indexRow: number[] = [];
        const a = pi2 - alpha - (Math.PI - alpha) * (y / capsBottomSegments);
        v += (radiusBottom * alpha) / capsBottomSegments;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        const ringRadius = cosA * radiusBottom;
        for (x = 0; x <= radialSegments; x++) {
            const u = x / radialSegments;
            const theta = u * thetaLength + thetaStart;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
            vertices.push(ringRadius * sinTheta, -halfHeight + sinA * radiusBottom, ringRadius * cosTheta);
            normals.push(cosA * sinTheta, sinA, cosA * cosTheta);
            uvs.push(u, 1 - v / vl);
            indexRow.push(index);
            index++;
        }
        indexArray.push(indexRow);
    }

    // Generate indices.
    for (x = 0; x < radialSegments; x++) {
        for (y = 0; y < capsTopSegments + heightSegments + capsBottomSegments; y++) {
            const i1 = indexArray[y]![x]!;
            const i2 = indexArray[y + 1]![x]!;
            const i3 = indexArray[y + 1]![x + 1]!;
            const i4 = indexArray[y]![x + 1]!;
            indices.push(i1, i2, i4);
            indices.push(i2, i3, i4);
        }
    }
    indices = indices.reverse();

    return {
        positions: new F32(vertices),
        normals: new F32(normals),
        uvs: new F32(uvs),
        indices: new U32(indices),
    };
}
