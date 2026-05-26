export const PBR_HAS_NORMAL_MAP = 1 << 0;
export const PBR_HAS_EMISSIVE = 1 << 1;
export const PBR_HAS_ENV = 1 << 2;
export const PBR_HAS_ALPHA_TEST = 1 << 3;
export const PBR_HAS_TONEMAP = 1 << 4;
export const PBR_HAS_ALPHA_BLEND = 1 << 6;
export const PBR_HAS_SPEC_GLOSS = 1 << 7;
export const PBR_HAS_DOUBLE_SIDED = 1 << 8;
export const PBR_HAS_COTANGENT_NORMAL = 1 << 9;
export const PBR_HAS_METALLIC_REFLECTANCE_MAP = 1 << 10;
export const PBR_HAS_REFLECTANCE_MAP = 1 << 11;
export const PBR_HAS_USE_ALPHA_ONLY_MR = 1 << 12;
export const PBR_HAS_OCCLUSION = 1 << 15;
export const PBR_HAS_SPECULAR_AA = 1 << 17;
export const PBR_HAS_CLEARCOAT = 1 << 20;
export const PBR_HAS_EMISSIVE_COLOR = 1 << 21;
export const PBR_HAS_SHEEN = 1 << 22;
export const PBR_HAS_SHEEN_TEXTURE = 1 << 23;
export const PBR_HAS_GAMMA_ALBEDO = 1 << 25;
export const PBR_HAS_ANISOTROPY = 1 << 26;
export const PBR_HAS_SUBSURFACE = 1 << 27;
export const PBR_HAS_THICKNESS_MAP = 1 << 28;
export const PBR_HAS_SKYBOX = 1 << 29;
export const PBR_HAS_SHEEN_ALBEDO_SCALING = 1 << 30;

// ─── features2 (extended feature bits) ──────────────────────────────
// Used when `features` runs out of bits. Threaded separately through
// composePbr / getOrCreatePbrPipeline / createPbrMeshBindGroup.
export const PBR2_CC_INT_MAP = 1 << 0;
export const PBR2_CC_ROUGH_MAP = 1 << 1;
export const PBR2_CC_NORMAL_MAP = 1 << 2;
export const PBR2_CC_F0_REMAP_OFF = 1 << 3;
/** Material has KHR_materials_transmission (refraction through surface). */
export const PBR2_HAS_REFRACTION = 1 << 4;
/** Material has KHR_materials_volume (thickness-based Beer-Lambert absorption). */
export const PBR2_HAS_VOLUME = 1 << 5;
/** Material has a transmission texture (R channel). */
export const PBR2_HAS_REFRACTION_MAP = 1 << 6;
/** Thickness texture samples the G channel (KHR_materials_volume). */
export const PBR2_HAS_THICKNESS_GLTF_CHANNEL = 1 << 7;
/** Material is unlit — bypass all lighting (KHR_materials_unlit). */
export const PBR2_HAS_UNLIT = 1 << 8;
/** Any bound texture on this material carries a non-identity UV transform
 *  (`uScale/vScale/uOffset/vOffset/uAng` on its Texture2D). Enables per-
 *  texture UV-transform UBO fields + `txfUV` wrapping in the shader. */
export const PBR2_HAS_UV_TRANSFORM = 1 << 9;
/** Material has non-default metallicF0Factor or metallicReflectanceColor
 *  without reflectance textures (factor-only KHR_materials_specular). */
export const PBR2_HAS_REFLECTANCE_FACTORS = 1 << 10;
/** Material samples occlusion from TEXCOORD_1 when the mesh provides UV2. */
export const PBR2_HAS_UV2 = 1 << 11;
/** Material has a sheen texture with a KHR_texture_transform. Sheen owns its
 *  own `sheenUVm`/`sheenUVt` UBO fields and applies txfUV locally. */
export const PBR2_HAS_SHEEN_UV_TX = 1 << 13;
/** Material participates in the opaque-scene refraction prepass and must be authored in linear space. */
export const PBR2_LINEAR_IMAGE_PROCESSING = 1 << 14;
/** Material view runs the fragment shader but declares no color output. */
export const PBR2_NO_COLOR_OUTPUT = 1 << 15;
/** Material view runs discard/clip logic and writes exponential shadow-map color. */
export const PBR2_ESM_SHADOW_OUTPUT = 1 << 16;
