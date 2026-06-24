/**
 * glTF optional-feature registry.
 *
 * The `_features` table maps every optional glTF capability to a `[trigger, load]`
 * pair: a cheap trigger plus a dynamic `import()` of the feature's `GltfFeature`
 * module. A trigger is either an exact `extensionsUsed` name (the common case) or
 * a predicate over the parsed JSON for features that aren't a simple extension
 * membership (ORM compositing, skeletons, morph targets, animations, dielectric
 * material cluster).
 *
 * This whole module is itself dynamically imported by the core loader
 * (`load-gltf.ts`) ONLY when the asset can possibly trigger at least one feature
 * — so assets that use no optional features (plain metallic-roughness GLBs) never
 * pay for the table or its import thunks.
 *
 * The core loader knows zero feature names; new extensions are added here alone.
 */
import type { GltfFeature } from "./gltf-feature.js";
import { anyPrimitive, needsOrmComposite } from "./gltf-parser.js";

/** Dynamic `import()` of a feature's `GltfFeature` module. */
type Loader = () => Promise<{ default: GltfFeature }>;
/** Either an exact `extensionsUsed` name, or a predicate over the parsed JSON. */
type Trigger = string | ((json: any) => boolean);

const M = "KHR_materials_";

const _features: [Trigger, Loader][] = [
    // Pre-parse features (buffer-level): order matters — meshopt decompresses
    // bufferViews first, then quantization dequantizes the resulting accessors.
    ["EXT_meshopt_compression", () => import("./gltf-feature-meshopt.js")],
    ["KHR_mesh_quantization", () => import("./gltf-ext-quantization.js")],
    // Pre-mesh features (geometry decompression)
    ["KHR_draco_mesh_compression", () => import("./gltf-feature-draco.js")],
    // Material extensions
    [M + "clearcoat", () => import("./gltf-ext-clearcoat.js")],
    [M + "iridescence", () => import("./gltf-ext-iridescence.js")],
    [M + "emissive_strength", () => import("./gltf-ext-emissive-strength.js")],
    [M + "sheen", () => import("./gltf-ext-sheen.js")],
    [M + "anisotropy", () => import("./gltf-ext-anisotropy.js")],
    [M + "diffuse_transmission", () => import("./gltf-ext-diffuse-transmission.js")],
    [M + "unlit", () => import("./gltf-ext-unlit.js")],
    [M + "pbrSpecularGlossiness", () => import("./gltf-ext-spec-gloss.js")],
    // Dielectric cluster (ior/specular/transmission/volume/dispersion) — any of the five triggers the
    // loader; transmission refraction is wired dynamically by the PBR material path when needed.
    [(j) => ["transmission", "volume", "ior", "specular", "dispersion"].some((e) => j.extensionsUsed?.includes(M + e)), () => import("./gltf-ext-dielectric.js")],
    ["KHR_texture_transform", () => import("./gltf-ext-uv-transform.js")],
    ["KHR_texture_basisu", () => import("./gltf-ext-basisu.js")],
    [needsOrmComposite, () => import("./gltf-ext-orm.js")],
    // Per-mesh features (predicates inlined to avoid eager imports)
    [(j) => !!j.skins?.length && anyPrimitive(j, (p) => p.attributes?.JOINTS_0 !== undefined), () => import("./gltf-feature-skeleton.js")],
    [(j) => anyPrimitive(j, (p) => !!p.targets?.length), () => import("./gltf-feature-morph.js")],
    // Non-triangle primitive topology (POINTS/LINES/LINE_STRIP/TRIANGLE_STRIP) or a
    // negative-determinant node (negative scale / mirrored matrix): both need the lazy primitive
    // feature (topology threading + winding reversal). Triangle-list positive-winding never triggers.
    [(j) => hasNegDetNode(j) || anyPrimitive(j, (p) => p.mode !== undefined && p.mode !== 4), () => import("./gltf-feature-primitive.js")],
    // Per-asset features
    [hasGltfExtras, () => import("./gltf-feature-extras.js")],
    ["KHR_lights_punctual", () => import("./gltf-feature-lights-punctual.js")],
    [(j) => !!j.animations?.length, () => import("./gltf-feature-animations.js")],
    // Non-Float32 / normalized animation sampler accessors (e.g. Animation_SamplerType normalized
    // BYTE/SHORT rotation) need the lazy denorm converter; plain float samplers never load it.
    [hasNonFloatAnimSampler, () => import("./gltf-sampler-denorm.js")],
    [M + "variants", () => import("./gltf-feature-variants.js")],
    ["KHR_node_visibility", () => import("./gltf-ext-node-visibility.js")],
    ["KHR_animation_pointer", () => import("./gltf-feature-animation-pointer.js")],
    ["EXT_mesh_gpu_instancing", () => import("./gltf-feature-gpu-instancing.js")],
    ["KHR_xmp_json_ld", () => import("./gltf-feature-xmp.js")],
];

/** Dynamic-import every feature the asset triggers. */
export async function loadGltfFeatures(json: any): Promise<GltfFeature[]> {
    const used: string[] = json.extensionsUsed ?? [];
    const mods = await Promise.all(_features.flatMap(([t, load]) => ((typeof t === "string" ? used.includes(t) : t(json)) ? [load()] : [])));
    return mods.map((m) => m.default);
}

function hasGltfExtras(json: any): boolean {
    const hasExtras = (item: any): boolean => item?.extras !== undefined;
    return (
        hasExtras(json.asset) ||
        !!json.nodes?.some(hasExtras) ||
        !!json.materials?.some(hasExtras) ||
        !!json.animations?.some(hasExtras) ||
        !!json.meshes?.some(hasExtras) ||
        anyPrimitive(json, hasExtras)
    );
}

/** True if any animation sampler reads a non-Float32 input/output accessor (normalized BYTE/SHORT
 *  rotation output, normalized UNSIGNED_BYTE flags, …) — the only case that needs the lazy sampler
 *  denorm converter. Plain Float32 samplers (the overwhelming majority) skip it. */
function hasNonFloatAnimSampler(json: any): boolean {
    const accessors = json.accessors;
    return !!(json.animations as any[] | undefined)?.some((a) =>
        a.samplers?.some((s: any) => accessors[s.input]?.componentType !== 5126 || accessors[s.output]?.componentType !== 5126)
    );
}

/** True if any node introduces a negative-determinant local transform — a
 *  negative scale (odd number of negative components) or a `matrix` with a
 *  negative 3x3 determinant. Such a node (or a child of one) can flip a mesh's
 *  net world determinant positive, reversing its triangle winding. Gates the
 *  lazy negative-winding feature so positive-scale / pure-TRS assets never load
 *  it. A negative-determinant node whose meshes' net world determinant stays
 *  negative over-triggers harmlessly (the feature then finds a non-positive
 *  determinant per mesh and flags nothing). */
function hasNegDetNode(json: any): boolean {
    return !!(json.nodes as any[] | undefined)?.some((n) => {
        if (n.scale) {
            return n.scale[0] * n.scale[1] * n.scale[2] < 0;
        }
        if (n.matrix) {
            const m = n.matrix;
            return m[0] * (m[5] * m[10] - m[6] * m[9]) + m[1] * (m[6] * m[8] - m[4] * m[10]) + m[2] * (m[4] * m[9] - m[5] * m[8]) < 0;
        }
        return false;
    });
}
