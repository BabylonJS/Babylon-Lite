/**
 * Ground from heightmap — matches Babylon.js MeshBuilder.CreateGroundFromHeightMap.
 *
 * Creates a subdivided plane, loads a heightmap image, displaces Y values
 * based on the heightmap luminance, and recomputes normals.
 *
 * Grid: (subdivisions + 1) × (subdivisions + 1) vertices
 * Position range: [-width/2, width/2] in X, [-height/2, height/2] in Z
 * UV: (0,1) at top-left, (1,0) at bottom-right (matching Babylon convention)
 */

export interface GroundData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

export interface GroundOptions {
    width?: number;
    height?: number;
    subdivisions?: number;
    minHeight?: number;
    maxHeight?: number;
    /** UV scale factor [uScale, vScale]. Multiplies generated UVs for texture tiling. Default [1, 1]. */
    uvScale?: [number, number];
}

/**
 * Create a flat ground plane. Call applyHeightmap() after to displace.
 */
export function createFlatGroundData(opts: GroundOptions = {}): GroundData {
    const width = opts.width ?? 1;
    const height = opts.height ?? 1;
    const subdivisions = opts.subdivisions ?? 1;
    const cols = subdivisions + 1;
    const rows = cols;
    const vertexCount = cols * rows;
    const indexCount = subdivisions * subdivisions * 6;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(indexCount);

    // Generate vertices
    let vi = 0;
    let ui = 0;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = -width / 2 + (col / subdivisions) * width;
            const z = -height / 2 + (1 - row / subdivisions) * height;

            positions[vi] = x;
            positions[vi + 1] = 0; // Y = 0 initially
            positions[vi + 2] = z;

            normals[vi] = 0;
            normals[vi + 1] = 1;
            normals[vi + 2] = 0;

            vi += 3;

            // Babylon UV: col/subdivisions, 1 - row/subdivisions
            uvs[ui] = col / subdivisions;
            uvs[ui + 1] = 1 - row / subdivisions;
            ui += 2;
        }
    }

    // Apply UV scale for texture tiling
    const uScale = opts.uvScale?.[0] ?? 1;
    const vScale = opts.uvScale?.[1] ?? 1;
    if (uScale !== 1 || vScale !== 1) {
        for (let i = 0; i < uvs.length; i += 2) {
            uvs[i] = uvs[i]! * uScale;
            uvs[i + 1] = uvs[i + 1]! * vScale;
        }
    }

    // Generate indices — Babylon uses specific winding
    let ii = 0;
    for (let row = 0; row < subdivisions; row++) {
        for (let col = 0; col < subdivisions; col++) {
            const topLeft = row * cols + col;
            const topRight = topLeft + 1;
            const bottomLeft = (row + 1) * cols + col;
            const bottomRight = bottomLeft + 1;

            indices[ii++] = bottomRight;
            indices[ii++] = topRight;
            indices[ii++] = topLeft;

            indices[ii++] = bottomLeft;
            indices[ii++] = bottomRight;
            indices[ii++] = topLeft;
        }
    }

    return { positions, normals, uvs, indices };
}

/**
 * Apply heightmap displacement from image pixel data.
 * The heightmap image must already be loaded and drawn to a canvas
 * so we can read pixel data.
 */
function applyHeightmap(ground: GroundData, heightmapData: Uint8ClampedArray, hmWidth: number, hmHeight: number, subdivisions: number, minHeight: number, maxHeight: number): void {
    const cols = subdivisions + 1;
    const rows = cols;
    const range = maxHeight - minHeight;

    // Displace Y based on heightmap luminance
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            // Sample heightmap at corresponding UV
            const u = col / subdivisions;
            const v = row / subdivisions; // row 0 = top of image
            // Babylon: floor(u * (bufferWidth - 1)), floor(v * (bufferHeight - 1))
            const px = (u * (hmWidth - 1)) | 0;
            const py = (v * (hmHeight - 1)) | 0;
            const pixIdx = (py * hmWidth + px) * 4;
            const r = heightmapData[pixIdx]! / 255;
            const g = heightmapData[pixIdx + 1]! / 255;
            const b = heightmapData[pixIdx + 2]! / 255;
            // Babylon uses weighted luminance: r * 0.3 + g * 0.59 + b * 0.11
            const gradient = r * 0.3 + g * 0.59 + b * 0.11;
            ground.positions[idx * 3 + 1] = minHeight + gradient * range;
        }
    }

    // Recompute normals from cross products
    // Reset normals to zero
    ground.normals.fill(0);

    for (let i = 0; i < ground.indices.length; i += 3) {
        const i0 = ground.indices[i]!;
        const i1 = ground.indices[i + 1]!;
        const i2 = ground.indices[i + 2]!;

        const pos = ground.positions;
        const p0x = pos[i0 * 3]!;
        const p0y = pos[i0 * 3 + 1]!;
        const p0z = pos[i0 * 3 + 2]!;
        const p1x = pos[i1 * 3]!;
        const p1y = pos[i1 * 3 + 1]!;
        const p1z = pos[i1 * 3 + 2]!;
        const p2x = pos[i2 * 3]!;
        const p2y = pos[i2 * 3 + 1]!;
        const p2z = pos[i2 * 3 + 2]!;

        // Edge vectors
        const e1x = p1x - p0x;
        const e1y = p1y - p0y;
        const e1z = p1z - p0z;
        const e2x = p2x - p0x;
        const e2y = p2y - p0y;
        const e2z = p2z - p0z;

        // Cross product (face normal) — negated to match Lite's CCW winding convention
        let fnx = -(e1y * e2z - e1z * e2y);
        let fny = -(e1z * e2x - e1x * e2z);
        let fnz = -(e1x * e2y - e1y * e2x);

        // Normalize face normal before accumulation (equal-weight per face,
        // matching Babylon's ComputeNormals which normalizes each face normal
        // before adding to vertices).
        const fnMag = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz) || 1;
        fnx /= fnMag;
        fny /= fnMag;
        fnz /= fnMag;

        // Accumulate unit face normals
        const nrm = ground.normals;
        nrm[i0 * 3] = nrm[i0 * 3]! + fnx;
        nrm[i0 * 3 + 1] = nrm[i0 * 3 + 1]! + fny;
        nrm[i0 * 3 + 2] = nrm[i0 * 3 + 2]! + fnz;
        nrm[i1 * 3] = nrm[i1 * 3]! + fnx;
        nrm[i1 * 3 + 1] = nrm[i1 * 3 + 1]! + fny;
        nrm[i1 * 3 + 2] = nrm[i1 * 3 + 2]! + fnz;
        nrm[i2 * 3] = nrm[i2 * 3]! + fnx;
        nrm[i2 * 3 + 1] = nrm[i2 * 3 + 1]! + fny;
        nrm[i2 * 3 + 2] = nrm[i2 * 3 + 2]! + fnz;
    }

    // Normalize
    const vCount = ground.positions.length / 3;
    for (let i = 0; i < vCount; i++) {
        const nx = ground.normals[i * 3]!;
        const ny = ground.normals[i * 3 + 1]!;
        const nz = ground.normals[i * 3 + 2]!;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        ground.normals[i * 3] = nx / len;
        ground.normals[i * 3 + 1] = ny / len;
        ground.normals[i * 3 + 2] = nz / len;
    }
}

/**
 * Load heightmap image and create ground mesh data.
 */
export async function createGroundFromHeightMap(heightmapUrl: string, opts: GroundOptions = {}): Promise<GroundData> {
    const subdivisions = opts.subdivisions ?? 1;
    const minHeight = opts.minHeight ?? 0;
    const maxHeight = opts.maxHeight ?? 1;

    const ground = createFlatGroundData(opts);

    // Load image and extract pixel data
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e) => reject(e instanceof Error ? e : new Error(String(e)));
        img.src = heightmapUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);

    applyHeightmap(ground, imageData.data, img.width, img.height, subdivisions, minHeight, maxHeight);

    return ground;
}
