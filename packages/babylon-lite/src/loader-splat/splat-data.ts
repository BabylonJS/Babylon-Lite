/** Splat row-buffer → GPU-ready typed arrays + bbox.
 *
 *  Input  : ArrayBuffer in the standard splat row layout
 *           (32 bytes/splat — see `splat-ply-parser.ts`).
 *  Output : positions/covA/covB (RGBA32F-packed, 4 floats per texel)
 *           + colours (RGBA32F, 0..1)
 *           + texture dimensions large enough to hold all splats one-per-texel
 *           + axis-aligned bounding box (used for camera framing).
 *
 *  The math mirrors BJS `GaussianSplattingMesh._loadData`: rotate-then-scale
 *  the unit covariance matrix and store its 6 unique upper-triangle entries as
 *  two RGB triples (covA[xy/zw split via vec3+vec3]). */

const ROW_LENGTH = 32;

export interface SplatGeometry {
    /** Number of splats parsed from the buffer. */
    vertexCount: number;
    /** Tight AABB across all splat centres (PLY-space). */
    boundMin: [number, number, number];
    boundMax: [number, number, number];
    /** Texture dimensions. width × height ≥ vertexCount, padded to texture row. */
    textureWidth: number;
    textureHeight: number;
    /** Splat centre positions, flat XYZ Float32 (length = 3 × vertexCount). */
    positions: Float32Array;
    /** RGBA32F texture data, one texel per splat. */
    centersRGBA: Float32Array;
    covARGBA: Float32Array;
    covBRGBA: Float32Array;
    colorsRGBA: Float32Array;
}

/** Pick a (width, height) so that width × height ≥ length and width is a
 *  power of two ≤ 4096 (matches the upper bound BJS uses on WebGL2/WebGPU,
 *  conservative enough for any device exposed via WebGPU). */
function chooseTextureSize(length: number): { width: number; height: number } {
    const width = 4096;
    const height = Math.max(1, Math.ceil(length / width));
    return { width, height };
}

/** Decode a splat row buffer into the textures + auxiliary arrays needed by the renderer. */
export function buildSplatGeometry(splatBuffer: ArrayBuffer): SplatGeometry {
    const u = new Uint8Array(splatBuffer);
    const f = new Float32Array(splatBuffer);
    const vertexCount = (u.byteLength / ROW_LENGTH) | 0;
    if (vertexCount === 0) {
        throw new Error("splat buffer is empty");
    }

    const { width, height } = chooseTextureSize(vertexCount);
    const texelCount = width * height;

    const positions = new Float32Array(vertexCount * 3);
    const centersRGBA = new Float32Array(texelCount * 4);
    const covARGBA = new Float32Array(texelCount * 4);
    const covBRGBA = new Float32Array(texelCount * 4);
    const colorsRGBA = new Float32Array(texelCount * 4);

    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    // Scratch matrices: rotation R, scaling S, M = R * S, then Σ = M · Mᵀ.
    // We only ever need the 6 upper-triangle entries of Σ, packed into covA/covB.
    const M = new Float32Array(9);

    for (let i = 0; i < vertexCount; i++) {
        const fi = i * 8; // 8 floats per row before the colour/rot tail
        const ui = i * ROW_LENGTH;

        const x = f[fi]!;
        const y = -f[fi + 1]!;
        const z = f[fi + 2]!;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        if (x < minX) {
            minX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z > maxZ) {
            maxZ = z;
        }

        // centresTexture: vec4(xyz, 1).
        centersRGBA[i * 4] = x;
        centersRGBA[i * 4 + 1] = y;
        centersRGBA[i * 4 + 2] = z;
        centersRGBA[i * 4 + 3] = 1;

        // colour: 0..255 → 0..1
        colorsRGBA[i * 4] = u[ui + 24]! / 255;
        colorsRGBA[i * 4 + 1] = u[ui + 25]! / 255;
        colorsRGBA[i * 4 + 2] = u[ui + 26]! / 255;
        colorsRGBA[i * 4 + 3] = u[ui + 27]! / 255;

        // Quaternion from biased uint8 (BJS layout: w, x, y, z at bytes 28..31).
        // Bias matches BJS exactly (× 127.5 + 127.5).  We then normalise the
        // dequantised quaternion — the byte → float round-trip can leave |q|
        // up to ~0.4% per component off-unit, and BJS does the same `q.normalize()`
        // in `_makeSplat`, so this keeps Σ values byte-equal to BJS.
        // No sign flips: BJS's `(qx, qy, qz, -qw)` decode + Babylon's column-major
        // matrix-multiply (which actually computes S · R, not R · S) results in
        // Σ = R_orig · diag((2s)²) · R_orig^T via column-norms.  Our path computes
        // Σ via row-norms of M = R · diag(2s) — both converge to the same Σ.
        let qw = -(u[ui + 28]! - 127.5) / 127.5; // flip here to compensate flip on Y position
        let qx = (u[ui + 29]! - 127.5) / 127.5;
        let qy = -(u[ui + 30]! - 127.5) / 127.5; // flip here to compensate flip on Y position
        let qz = (u[ui + 31]! - 127.5) / 127.5;
        const qLen = Math.hypot(qw, qx, qy, qz) || 1;
        const qInv = 1 / qLen;
        qw *= qInv;
        qx *= qInv;
        qy *= qInv;
        qz *= qInv;

        // Rotation matrix (column-major, like BJS), pre-multiplied with diag(2 * scale).
        const sx = f[fi + 3]! * 2;
        const sy = f[fi + 4]! * 2;
        const sz = f[fi + 5]! * 2;

        const xx = qx * qx,
            yy = qy * qy,
            zz = qz * qz;
        const xy = qx * qy,
            xz = qx * qz,
            yz = qy * qz;
        const wx = qw * qx,
            wy = qw * qy,
            wz = qw * qz;

        // R, column-major
        const r00 = 1 - 2 * (yy + zz);
        const r01 = 2 * (xy + wz);
        const r02 = 2 * (xz - wy);
        const r10 = 2 * (xy - wz);
        const r11 = 1 - 2 * (xx + zz);
        const r12 = 2 * (yz + wx);
        const r20 = 2 * (xz + wy);
        const r21 = 2 * (yz - wx);
        const r22 = 1 - 2 * (xx + yy);

        // M = R * diag(scale*2). Column j of M = column j of R * scale[j].
        M[0] = r00 * sx;
        M[1] = r01 * sx;
        M[2] = r02 * sx;
        M[3] = r10 * sy;
        M[4] = r11 * sy;
        M[5] = r12 * sy;
        M[6] = r20 * sz;
        M[7] = r21 * sz;
        M[8] = r22 * sz;

        // Σ = M · Mᵀ → store the 6 unique entries
        // covA = (Σ00, Σ01, Σ02), covB = (Σ11, Σ12, Σ22).
        const a0 = M[0]! * M[0]! + M[3]! * M[3]! + M[6]! * M[6]!;
        const a1 = M[0]! * M[1]! + M[3]! * M[4]! + M[6]! * M[7]!;
        const a2 = M[0]! * M[2]! + M[3]! * M[5]! + M[6]! * M[8]!;
        const b0 = M[1]! * M[1]! + M[4]! * M[4]! + M[7]! * M[7]!;
        const b1 = M[1]! * M[2]! + M[4]! * M[5]! + M[7]! * M[8]!;
        const b2 = M[2]! * M[2]! + M[5]! * M[5]! + M[8]! * M[8]!;

        covARGBA[i * 4] = a0;
        covARGBA[i * 4 + 1] = a1;
        covARGBA[i * 4 + 2] = a2;
        covARGBA[i * 4 + 3] = 1;
        covBRGBA[i * 4] = b0;
        covBRGBA[i * 4 + 1] = b1;
        covBRGBA[i * 4 + 2] = b2;
        covBRGBA[i * 4 + 3] = 1;
    }

    return {
        vertexCount,
        boundMin: [minX, minY, minZ],
        boundMax: [maxX, maxY, maxZ],
        textureWidth: width,
        textureHeight: height,
        positions,
        centersRGBA,
        covARGBA,
        covBRGBA,
        colorsRGBA,
    };
}
