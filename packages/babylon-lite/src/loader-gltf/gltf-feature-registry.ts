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
    // Per-asset features
    ["KHR_lights_punctual", () => import("./gltf-feature-lights-punctual.js")],
    [(j) => !!j.animations?.length, () => import("./gltf-feature-animations.js")],
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
