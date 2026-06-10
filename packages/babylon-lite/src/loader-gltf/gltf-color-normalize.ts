/** glTF COLOR_0 vertex-color normalization — dynamically imported.
 *
 *  Isolated from the core loader so scenes whose assets have no COLOR_0 attribute
 *  (the common case) never bundle or fetch this code. Loaded lazily by
 *  `load-gltf.ts` only when a primitive actually provides COLOR_0.
 *
 *  Zero module-level side effects — safe for tree-shaking.
 */

/** Normalize a glTF COLOR_0 attribute to a tight float32 VEC3 (RGB) buffer.
 *
 *  The PBR/standard vertex pipelines bind vertex color as a single format: `float32x3`
 *  (stride 12). glTF COLOR_0 is far more permissive — it may be VEC3 or VEC4, and its
 *  component type may be float OR normalized unsigned byte/short. Binding any other layout
 *  to the stride-12 float pipeline misaligns every vertex (garbage / black colors). So we
 *  always convert here: integer types are normalized to [0,1] (per the glTF spec, integer
 *  COLOR_0 is always normalized), VEC4 alpha is dropped (Lite shading multiplies only the
 *  rgb of vertex color into the base color), and the result is a tight Float32Array RGB.
 *
 *  `data` is the resolved accessor view (Float32Array | Uint8Array | Uint16Array), `count`
 *  the vertex count, and `comps` the component count (3 or 4). */
export function normalizeColorToVec3(data: ArrayBufferView, count: number, comps: number): Float32Array {
    const out = new Float32Array(count * 3);
    if (data instanceof Float32Array) {
        for (let v = 0; v < count; v++) {
            out[v * 3] = data[v * comps]!;
            out[v * 3 + 1] = data[v * comps + 1]!;
            out[v * 3 + 2] = data[v * comps + 2]!;
        }
    } else if (data instanceof Uint16Array) {
        const inv = 1 / 65535;
        for (let v = 0; v < count; v++) {
            out[v * 3] = data[v * comps]! * inv;
            out[v * 3 + 1] = data[v * comps + 1]! * inv;
            out[v * 3 + 2] = data[v * comps + 2]! * inv;
        }
    } else if (data instanceof Uint8Array) {
        const inv = 1 / 255;
        for (let v = 0; v < count; v++) {
            out[v * 3] = data[v * comps]! * inv;
            out[v * 3 + 1] = data[v * comps + 1]! * inv;
            out[v * 3 + 2] = data[v * comps + 2]! * inv;
        }
    }
    return out;
}
