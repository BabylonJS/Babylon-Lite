/** glTF COLOR_0 vertex-color normalization — dynamically imported.
 *
 *  Isolated from the core loader so scenes whose assets have no COLOR_0 attribute
 *  (the common case) never bundle or fetch this code. Loaded lazily by
 *  `load-gltf.ts` only when a primitive actually provides COLOR_0.
 *
 *  Zero module-level side effects — safe for tree-shaking.
 */

/** Normalize a glTF COLOR_0 attribute to a tight float32 VEC4 (RGBA) buffer.
 *
 *  The PBR vertex pipeline binds vertex color as `float32x4` (stride 16), matching
 *  the rest of the engine (procedural meshes, node/shader materials). glTF COLOR_0
 *  is far more permissive — it may be VEC3 or VEC4, and its component type may be
 *  float OR normalized unsigned byte/short. Binding any other layout to the stride-16
 *  float pipeline misaligns every vertex (garbage / black colors). So we always
 *  convert here: integer types are normalized to [0,1] (per the glTF spec, integer
 *  COLOR_0 is always normalized), a VEC3 source gets alpha = 1.0, and the result is a
 *  tight Float32Array RGBA. The rgb modulates base color; the alpha modulates the
 *  fragment alpha (so vertex-color alpha drives alpha blending / alpha-clip).
 *
 *  `data` is the resolved accessor view (Float32Array | Uint8Array | Uint16Array), `count`
 *  the vertex count, and `comps` the component count (3 or 4). */
export function normalizeColorToVec4(data: ArrayBufferView, count: number, comps: number): Float32Array {
    const out = new Float32Array(count * 4);
    const hasAlpha = comps >= 4;
    if (data instanceof Float32Array) {
        for (let v = 0; v < count; v++) {
            out[v * 4] = data[v * comps]!;
            out[v * 4 + 1] = data[v * comps + 1]!;
            out[v * 4 + 2] = data[v * comps + 2]!;
            out[v * 4 + 3] = hasAlpha ? data[v * comps + 3]! : 1;
        }
    } else if (data instanceof Uint16Array) {
        const inv = 1 / 65535;
        for (let v = 0; v < count; v++) {
            out[v * 4] = data[v * comps]! * inv;
            out[v * 4 + 1] = data[v * comps + 1]! * inv;
            out[v * 4 + 2] = data[v * comps + 2]! * inv;
            out[v * 4 + 3] = hasAlpha ? data[v * comps + 3]! * inv : 1;
        }
    } else if (data instanceof Uint8Array) {
        const inv = 1 / 255;
        for (let v = 0; v < count; v++) {
            out[v * 4] = data[v * comps]! * inv;
            out[v * 4 + 1] = data[v * comps + 1]! * inv;
            out[v * 4 + 2] = data[v * comps + 2]! * inv;
            out[v * 4 + 3] = hasAlpha ? data[v * comps + 3]! * inv : 1;
        }
    }
    return out;
}
