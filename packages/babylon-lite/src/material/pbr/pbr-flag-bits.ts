export const PBR_HAS_NORMAL_MAP = 1 << 0;
export const PBR_HAS_EMISSIVE = 1 << 1;
export const PBR_HAS_ENV = 1 << 2;
export const PBR_HAS_ALPHA_TEST = 1 << 3;
export const PBR_HAS_TONEMAP = 1 << 4;
/** Scene has fog enabled (scene.fog != null). A scene-feature bit (threaded via
 *  sceneFeatures), gating the PBR fog blend + calcFogFactor helper into the shader.
 *  Compile-time gated so non-fog PBR scenes stay byte-identical. */
export const PBR_HAS_FOG = 1 << 5;
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
// 1<<0 .. 1<<3 are clearcoat-local (clearcoat-fragment.ts).
/** Material has KHR_materials_transmission (refraction through surface). */
export const PBR2_HAS_REFRACTION = 1 << 4;
// 1<<5 .. 1<<7 are refraction/subsurface-local; 1<<8 is unlit-local.
/** Any bound texture on this material carries a non-identity UV transform
 *  (`uScale/vScale/uOffset/vOffset/uAng` on its Texture2D). Enables per-
 *  texture UV-transform UBO fields + `txfUV` wrapping in the shader. */
export const PBR2_HAS_UV_TRANSFORM = 1 << 9;
/** Material has non-default metallicF0Factor or metallicReflectanceColor
 *  without reflectance textures (factor-only KHR_materials_specular). */
export const PBR2_HAS_REFLECTANCE_FACTORS = 1 << 10;
/** Material samples occlusion from TEXCOORD_1 when the mesh provides UV2. */
export const PBR2_HAS_UV2 = 1 << 11;
/** Material multiplies textured albedo by a non-default glTF baseColorFactor. */
export const PBR2_HAS_BASE_COLOR_FACTOR = 1 << 12;
// 1<<13 is sheen-local; 1<<14 is refraction-local.
/** Material view runs the fragment shader but declares no color output. */
export const PBR2_NO_COLOR_OUTPUT = 1 << 15;
/** Material view runs discard/clip logic and writes exponential shadow-map color. */
export const PBR2_ESM_SHADOW_OUTPUT = 1 << 16;
// 1<<17 .. 1<<19 are iridescence-local; 1<<20 is refraction-local;
// 1<<21 is geometry-output-local.
// ─── Extension-local features2 bits (1<<22 .. 1<<28) ────────────────
// RESERVED here but DEFINED inside their lazy fragment modules so the constants
// are never retained in the entry/shared chunk for scenes that don't load those
// fragments (literally zero bundle movement). Do not reuse these bits.
//   1<<22  PBR2_HAS_TRANSLUCENCY_COLOR_MAP      (subsurface-fragment.ts)
//   1<<23  PBR2_HAS_TRANSLUCENCY_INTENSITY_MAP  (subsurface-fragment.ts)
//   1<<24  PBR2_HAS_TRANSLUCENCY_UV_TX          (subsurface-fragment.ts)
//   1<<25  PBR2_CC_UV_TX                        (clearcoat-fragment.ts)
//   1<<26  PBR2_REFL_UV_TX                      (reflectance-fragment.ts)
//   1<<27  PBR2_HAS_ANISO_TEX                    (anisotropy-fragment.ts)
//   1<<28  PBR2_OCCL_UV_SPLIT                   (uv-transform-fragment.ts + pbr-template-ext.ts)
