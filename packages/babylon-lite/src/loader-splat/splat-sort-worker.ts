/** Splat sort worker.
 *
 *  Vite import: `import SortWorker from './splat-sort-worker.ts?worker&inline'`.
 *  The `?worker&inline` query keeps the bundled worker JS embedded as a base-64
 *  blob in the splat scene chunk — it adds zero bytes to any other scene
 *  because the whole `loader-splat/` module is dynamic-imported.
 *
 *  Protocol
 *  --------
 *  Init (once):  { positions: Float32Array, vertexCount: number }
 *                — buffer is transferred and retained on the worker side.
 *                — positions are in mesh-LOCAL space (stride 3, xyz per splat).
 *  Sort  (N×):   { worldMatrix: Float32Array(16),
 *                  cameraForward: Float32Array(3),
 *                  cameraPosition: Float32Array(3),
 *                  depthMix: BigInt64Array }
 *                — depthMix is round-tripped via transferable; layout is
 *                  high-32 bits = packed depth (then bit-inverted), low-32 bits = splat index.
 *                  After sort, low-32 bits give the back-to-front order.
 *
 *  Depth recipe (mirrors BJS `_CreateWorker`)
 *  ------------------------------------------
 *  Per-frame the main thread sends the mesh's world matrix, the camera's
 *  world-space forward vector and the camera's world-space position. The
 *  worker collapses these into 4 scalars (a, b, c, d) such that
 *     depth = a*localX + b*localY + c*localZ + d
 *           = cameraForward · (world · localPos - cameraPosition).
 *  This is more robust than the previous `10000 - dot(view-row, pos)` recipe:
 *    - it accounts for non-identity world matrices (BJS Lite previously ignored them);
 *    - it has no magic reference value, so it doesn't lose precision when
 *      depths are large or wrap signs when depths exceed the reference;
 *    - the back-to-front order is produced by bit-inverting the high 32 bits
 *      of each i64 slot (`~indices[2j+1]`) instead of subtracting depths from
 *      a constant — this preserves the full float precision range. */

let positions: Float32Array | null = null;
let vertexCount = 0;

self.onmessage = (e: MessageEvent) => {
    const data = e.data as {
        positions?: Float32Array;
        vertexCount?: number;
        worldMatrix?: Float32Array;
        cameraForward?: Float32Array;
        cameraPosition?: Float32Array;
        depthMix?: BigInt64Array;
    };

    if (data.positions) {
        positions = data.positions;
        vertexCount = data.vertexCount ?? 0;
        return;
    }

    if (!positions || !data.worldMatrix || !data.cameraForward || !data.cameraPosition || !data.depthMix) {
        return;
    }

    const m = data.worldMatrix;
    const cf = data.cameraForward;
    const cp = data.cameraPosition;
    const depthMix = data.depthMix;
    const indices = new Uint32Array(depthMix.buffer);
    const floatMix = new Float32Array(depthMix.buffer);

    // Collapse cameraForward · (world · localPos - cameraPos) into (a*x + b*y + c*z + d).
    // Lite column-major: world's column k lives at indices [4k, 4k+1, 4k+2, 4k+3]
    // (the 4th row is always [0,0,0,1] for an affine matrix, so we skip m[3,7,11,15]).
    const camDot = cf[0]! * cp[0]! + cf[1]! * cp[1]! + cf[2]! * cp[2]!;
    const a = cf[0]! * m[0]! + cf[1]! * m[1]! + cf[2]! * m[2]!;
    const b = cf[0]! * m[4]! + cf[1]! * m[5]! + cf[2]! * m[6]!;
    const c = cf[0]! * m[8]! + cf[1]! * m[9]! + cf[2]! * m[10]!;
    const d = cf[0]! * m[12]! + cf[1]! * m[13]! + cf[2]! * m[14]! - camDot;

    for (let j = 0; j < vertexCount; j++) {
        indices[2 * j] = j;
        floatMix[2 * j + 1] = a * positions[3 * j]! + b * positions[3 * j + 1]! + c * positions[3 * j + 2]! + d;
        // Bit-invert the high 32 bits (where the depth float lives) so that
        // BigInt64Array.sort() yields back-to-front order without subtracting
        // depths from a constant (which would cap range and erode precision).
        indices[2 * j + 1] = ~indices[2 * j + 1]!;
    }

    depthMix.sort();

    (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage({ depthMix }, [depthMix.buffer]);
};
