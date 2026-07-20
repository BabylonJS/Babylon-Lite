/** KHR_gaussian_splatting glTF extension.
 *
 *  Loads mesh primitives tagged with `KHR_gaussian_splatting` as Lite Gaussian
 *  Splatting renderables. A GS primitive is POINTS-mode geometry whose per-splat
 *  ellipsoid is described by the extension's custom vertex attributes
 *  (`KHR_gaussian_splatting:ROTATION` / `SCALE` / `OPACITY` and the SH degree-0
 *  DC term). It has no triangle topology, so it must NOT flow through the core
 *  mesh pipeline — the `preParse` hook strips GS primitives from their meshes so
 *  the core loader builds no geometry for them, then `applyAsset` converts the
 *  attributes into the standard 32-byte/splat row buffer that Lite's existing
 *  splat pipeline (`attachParsedSplat` → `buildSplatGeometry`) already consumes.
 *
 *  The row-buffer conversion mirrors Babylon.js' `KHR_gaussian_splatting` loader
 *  exactly (position + linear scale + DC-reconstructed colour + quantized wxyz
 *  quaternion). Lite's `buildSplatGeometry` negates Y (the `.ply`/`.splat`
 *  convention), so the attached splat mesh is rotated 180° about Z to match the
 *  BJS reference's net orientation (BJS keeps Y and applies its __root__ RH-to-LH
 *  negate-X flip); without this the splat is upside down / mis-oriented.
 *
 *  v1 scope: SH degree 0 (DC colour) only, and the splat is placed in glTF space
 *  (node transforms are not baked in), which matches single-splat-at-origin
 *  assets such as the reference `Halo_Believe.glb`. Higher-degree SH and node
 *  transforms are intentionally out of scope for this first cut.
 */

import type { GltfFeature } from "./gltf-feature.js";
import type { AssetContainer } from "../asset-container.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import { TYPE_SIZES } from "./gltf-parser.js";
import { attachParsedSplat } from "../loader-splat/load-splat.js";

const NAME = "KHR_gaussian_splatting";

// Attribute semantics defined by the KHR_gaussian_splatting ellipsoid kernel.
const RotationAttribute = "KHR_gaussian_splatting:ROTATION";
const ScaleAttribute = "KHR_gaussian_splatting:SCALE";
const OpacityAttribute = "KHR_gaussian_splatting:OPACITY";
const ShDegree0Attribute = "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0";

// glTF component types and their byte sizes.
const CT_BYTE = 5120;
const CT_UNSIGNED_BYTE = 5121;
const CT_SHORT = 5122;
const CT_UNSIGNED_SHORT = 5123;
const CT_UNSIGNED_INT = 5125;
const CT_FLOAT = 5126;
const COMPONENT_BYTES: Record<number, number> = { [CT_BYTE]: 1, [CT_UNSIGNED_BYTE]: 1, [CT_SHORT]: 2, [CT_UNSIGNED_SHORT]: 2, [CT_UNSIGNED_INT]: 4, [CT_FLOAT]: 4 };

// Zeroth-order spherical-harmonics coefficient used to reconstruct a base colour from the SH DC term.
const ShC0 = 0.28209479177387814;

// 32 bytes/splat: position(12) + scale(12) + colour RGBA(4) + quaternion wxyz(4).
const RowLength = 32;

/** One GS primitive captured during preParse, keyed by its resolved accessor indices. */
interface GsRecord {
    name: string;
    attributes: Record<string, number>;
}

function clamp255(value: number): number {
    return value <= 0 ? 0 : value >= 255 ? 255 : (value + 0.5) | 0;
}

/** True when a primitive carries the KHR_gaussian_splatting extension or its custom attributes. */
function isGsPrimitive(primitive: any): boolean {
    if (primitive?.extensions?.[NAME]) {
        return true;
    }
    const attributes = primitive?.attributes;
    if (!attributes) {
        return false;
    }
    for (const key in attributes) {
        if (key.startsWith(NAME + ":")) {
            return true;
        }
    }
    return false;
}

/**
 * Read an accessor as a tight Float32Array, honoring `bufferView.byteStride`
 * (interleaved sources) and normalizing integer component types per the glTF
 * `normalized` flag. Mirrors BJS `_loadFloatAccessorAsync`.
 *
 * NOTE: this deliberately does NOT go through `resolveAccessor`, which returns a
 * tightly-packed view and ignores `byteStride` — reading a strided KHR_gaussian_splatting
 * attribute through it would pick up padding / a neighbouring attribute and corrupt the splat.
 */
function readFloats(json: any, binChunk: DataView, accessorIdx: number): Float32Array {
    const accessor = json.accessors[accessorIdx];
    const componentCount = TYPE_SIZES[accessor.type] ?? 1;
    const count: number = accessor.count;
    const out = new Float32Array(count * componentCount);
    // Spec: an accessor with no bufferView is zero-initialized (values may come from an extension).
    if (accessor.bufferView === undefined) {
        return out;
    }
    const bufferView = json.bufferViews[accessor.bufferView];
    const ct: number = accessor.componentType;
    const compBytes = COMPONENT_BYTES[ct] ?? 4;
    const elemBytes = componentCount * compBytes;
    // Interleaved sources set byteStride; tight sources fall back to the packed element size.
    const stride: number = bufferView.byteStride ?? elemBytes;
    const normalized = !!accessor.normalized;
    const base = binChunk.byteOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const dv = new DataView(binChunk.buffer as ArrayBuffer);
    for (let v = 0; v < count; v++) {
        const rowBase = base + v * stride;
        for (let c = 0; c < componentCount; c++) {
            const off = rowBase + c * compBytes;
            let value: number;
            switch (ct) {
                case CT_FLOAT:
                    value = dv.getFloat32(off, true);
                    break;
                case CT_UNSIGNED_BYTE:
                    value = normalized ? dv.getUint8(off) / 255 : dv.getUint8(off);
                    break;
                case CT_BYTE:
                    value = normalized ? Math.max(dv.getInt8(off) / 127, -1) : dv.getInt8(off);
                    break;
                case CT_UNSIGNED_SHORT:
                    value = normalized ? dv.getUint16(off, true) / 65535 : dv.getUint16(off, true);
                    break;
                case CT_SHORT:
                    value = normalized ? Math.max(dv.getInt16(off, true) / 32767, -1) : dv.getInt16(off, true);
                    break;
                case CT_UNSIGNED_INT:
                    value = dv.getUint32(off, true);
                    break;
                default:
                    value = dv.getFloat32(off, true);
                    break;
            }
            out[v * componentCount + c] = value;
        }
    }
    return out;
}

/** Convert one GS primitive's glTF attributes into a standard 32-byte/splat row buffer. */
function buildSplatBuffer(json: any, binChunk: DataView, rec: GsRecord): ArrayBuffer {
    const attrs = rec.attributes;
    const positions = readFloats(json, binChunk, attrs["POSITION"]!);
    const splatCount = (positions.length / 3) | 0;

    const scales = attrs[ScaleAttribute] !== undefined ? readFloats(json, binChunk, attrs[ScaleAttribute]!) : null;
    const rotations = attrs[RotationAttribute] !== undefined ? readFloats(json, binChunk, attrs[RotationAttribute]!) : null;
    const opacities = attrs[OpacityAttribute] !== undefined ? readFloats(json, binChunk, attrs[OpacityAttribute]!) : null;
    const shDegree0 = attrs[ShDegree0Attribute] !== undefined ? readFloats(json, binChunk, attrs[ShDegree0Attribute]!) : null;
    const colors = attrs["COLOR_0"] !== undefined ? readFloats(json, binChunk, attrs["COLOR_0"]!) : null;
    const colorStride = colors ? (colors.length / splatCount) | 0 : 0;

    const buffer = new ArrayBuffer(RowLength * splatCount);
    const floatView = new Float32Array(buffer);
    const byteView = new Uint8Array(buffer);

    for (let i = 0; i < splatCount; i++) {
        const floatBase = i * 8;
        const byteBase = i * RowLength;
        const p = i * 3;

        // Position (float32 x3, bytes 0-11).
        floatView[floatBase + 0] = positions[p + 0]!;
        floatView[floatBase + 1] = positions[p + 1]!;
        floatView[floatBase + 2] = positions[p + 2]!;

        // Scale (float32 x3, bytes 12-23) — glTF stores linear scale directly.
        floatView[floatBase + 3] = scales ? scales[p + 0]! : 1;
        floatView[floatBase + 4] = scales ? scales[p + 1]! : 1;
        floatView[floatBase + 5] = scales ? scales[p + 2]! : 1;

        // Colour RGB (uint8 x3, bytes 24-26) — reconstructed from the SH DC term, or COLOR_0 as a fallback.
        if (shDegree0) {
            byteView[byteBase + 24] = clamp255((0.5 + ShC0 * shDegree0[p + 0]!) * 255);
            byteView[byteBase + 25] = clamp255((0.5 + ShC0 * shDegree0[p + 1]!) * 255);
            byteView[byteBase + 26] = clamp255((0.5 + ShC0 * shDegree0[p + 2]!) * 255);
        } else if (colors) {
            const c = i * colorStride;
            byteView[byteBase + 24] = clamp255(colors[c + 0]! * 255);
            byteView[byteBase + 25] = clamp255(colors[c + 1]! * 255);
            byteView[byteBase + 26] = clamp255(colors[c + 2]! * 255);
        } else {
            byteView[byteBase + 24] = 255;
            byteView[byteBase + 25] = 255;
            byteView[byteBase + 26] = 255;
        }

        // Alpha (uint8, byte 27) — opacity is a normalized linear value per spec.
        if (opacities) {
            byteView[byteBase + 27] = clamp255(opacities[i]! * 255);
        } else if (colors && colorStride >= 4) {
            byteView[byteBase + 27] = clamp255(colors[i * colorStride + 3]! * 255);
        } else {
            byteView[byteBase + 27] = 255;
        }

        // Quaternion (uint8 x4, bytes 28-31) stored as wxyz encoded as q * 127.5 + 127.5. glTF stores xyzw.
        const r = i * 4;
        const qx = rotations ? rotations[r + 0]! : 0;
        const qy = rotations ? rotations[r + 1]! : 0;
        const qz = rotations ? rotations[r + 2]! : 0;
        const qw = rotations ? rotations[r + 3]! : 1;
        byteView[byteBase + 28] = clamp255(qw * 127.5 + 127.5);
        byteView[byteBase + 29] = clamp255(qx * 127.5 + 127.5);
        byteView[byteBase + 30] = clamp255(qy * 127.5 + 127.5);
        byteView[byteBase + 31] = clamp255(qz * 127.5 + 127.5);
    }

    return buffer;
}

const feature: GltfFeature = {
    id: NAME,

    // Strip GS primitives before mesh extraction so the core loader builds no
    // triangle/point geometry for them, and stash the accessor indices for applyAsset.
    async preParse(json: any) {
        const records: GsRecord[] = [];
        const meshes = json.meshes ?? [];
        for (let mi = 0; mi < meshes.length; mi++) {
            const mesh = meshes[mi];
            const primitives = mesh?.primitives;
            if (!primitives?.length) {
                continue;
            }
            const kept: any[] = [];
            for (let pi = 0; pi < primitives.length; pi++) {
                const primitive = primitives[pi];
                if (isGsPrimitive(primitive)) {
                    records.push({ name: `${mesh.name ?? "splat"}_${mi}_${pi}`, attributes: primitive.attributes });
                } else {
                    kept.push(primitive);
                }
            }
            mesh.primitives = kept;
        }
        if (records.length) {
            json.__gsSplats = records;
        }
    },

    // Convert the captured GS primitives to splat row buffers and wire the
    // resulting renderables into the scene once addToScene supplies the context.
    async applyAsset(_meshes, _root, ctx): Promise<Partial<AssetContainer>> {
        const records: GsRecord[] | undefined = ctx._json.__gsSplats;
        if (!records?.length) {
            return {};
        }

        // Heavy conversion (accessor reads + row packing) happens here, before the
        // scene exists — only the GPU upload + sort worker are deferred to _sceneSetup.
        const prepared = records.map((rec) => ({ name: rec.name, buffer: buildSplatBuffer(ctx._json, ctx._binChunk, rec) }));

        const ready: Promise<GaussianSplattingMesh>[] = [];
        const sceneSetup = (scene: SceneContext): void => {
            for (const item of prepared) {
                // Rotate 180° about Z so the glTF-authored splat matches the BJS reference orientation.
                // buildSplatGeometry negates Y (the .ply/.splat convention) giving (x,-y,z); BJS' glTF
                // loader instead keeps Y and applies its __root__ RH->LH flip (net negate-X). Rotating
                // 180° about Z here (negate X and Y) turns (x,-y,z) into (-x,y,z) == BJS' net result.
                ready.push(
                    attachParsedSplat(scene, item.name, { data: item.buffer }).then((mesh) => {
                        mesh.rotation.z = Math.PI;
                        return mesh;
                    })
                );
            }
        };

        return { _sceneSetup: sceneSetup, _gaussianSplats: ready };
    },
};

export default feature;
