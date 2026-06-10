/**
 * Geometry renderer texture types.
 *
 * Each enum value corresponds to a single geometry attachment that
 * {@link createGeometryRendererTask} can write to. The companion
 * {@link GEOMETRY_TEXTURE_DESCRIPTIONS} table provides the default
 * per-type WebGPU format and the clear behaviour at the start of a
 * geometry pass.
 *
 * The enum is intentionally a subset of Babylon.js'
 * `MaterialHelperGeometryRendering.GeometryTextureDescriptions`. The
 * following BJS types are excluded by design:
 *   - `ALBEDO_SQRT`           — we only expose `ALBEDO`.
 *   - `VELOCITY` (vec2 SS)    — we only expose `LINEAR_VELOCITY` (vec3 WS).
 *   - `IRRADIANCE_LEGACY`     — we only expose `IRRADIANCE`.
 *   - `COLOR`                 — handled separately via the geometry task's
 *                               optional `targetTexture` color attachment
 *                               (BJS `PREPASS_COLOR_INDEX`).
 *
 * Module is lazy-loaded by the geometry view and the geometry task only;
 * existing scenes never import it.
 */

/** Identifies a single geometry texture supported by `createGeometryRendererTask`. */
export enum GeometryTextureType {
    /** Half-float RGBA — diffuse irradiance accumulated at the surface. */
    IRRADIANCE = 0,
    /** Half-float RGBA — world-space position. */
    WORLD_POSITION = 1,
    /** Half-float RGBA — object-local position (before world transform). */
    LOCAL_POSITION = 2,
    /** Unorm8 RGBA — material reflectivity (rgb) + roughness (a). */
    REFLECTIVITY = 3,
    /** Float R — linear view-space depth (camera-far at the far plane). Cleared to camera far. */
    VIEW_DEPTH = 4,
    /** Half-float R — view-space depth normalized to [0,1] (1 at the far plane). */
    NORMALIZED_VIEW_DEPTH = 5,
    /** Half-float R — clip-space depth in [0,1] (matches GPU depth buffer post-projection). */
    SCREENSPACE_DEPTH = 6,
    /** Half-float RGBA — view-space surface normal. */
    VIEW_NORMAL = 7,
    /** Half-float RGBA — world-space surface normal. */
    WORLD_NORMAL = 8,
    /** Unorm8 RGBA — surface albedo (diffuse colour, no lighting). */
    ALBEDO = 9,
    /** Half-float RGBA — per-pixel linear world-space velocity in units / frame. */
    LINEAR_VELOCITY = 10,
}

/** Clear behaviour applied to a geometry attachment at the start of a geometry pass. */
export type GeometryClearValue = GPUColor;

/** Per-type defaults for {@link GeometryTextureType}. Indexed by the enum value. */
export interface GeometryTextureDescription {
    /** Human-readable name. Mirrors BJS `GeometryTextureDescriptions[].name`. */
    readonly name: string;
    /** Default WebGPU color format for the attachment. Callers may override per attachment. */
    readonly defaultFormat: GPUTextureFormat;
    readonly clearValue: GeometryClearValue;
}

const ZERO: GPUColor = { r: 0, g: 0, b: 0, a: 0 };
const ONE: GPUColor = { r: 1, g: 1, b: 1, a: 1 };

/**
 * Per-type descriptor table. The array is indexed by {@link GeometryTextureType},
 * so `GEOMETRY_TEXTURE_DESCRIPTIONS[type]` is the entry for `type`.
 */
export const GEOMETRY_TEXTURE_DESCRIPTIONS: readonly GeometryTextureDescription[] = [
    { name: "Irradiance", defaultFormat: "rgba16float", clearValue: ZERO },
    { name: "WorldPosition", defaultFormat: "rgba16float", clearValue: ZERO },
    { name: "LocalPosition", defaultFormat: "rgba16float", clearValue: ZERO },
    { name: "Reflectivity", defaultFormat: "rgba8unorm", clearValue: ZERO },
    { name: "ViewDepth", defaultFormat: "r32float", clearValue: ZERO },
    { name: "NormalizedViewDepth", defaultFormat: "r16float", clearValue: ONE },
    // Reverse-Z: clip-space Z maps far→0, near→1, so the background (no geometry)
    // clears to 0 (far). BJS clears this to 1, which is incorrect under reverse-Z.
    { name: "ScreenspaceDepth", defaultFormat: "r16float", clearValue: ZERO },
    { name: "ViewNormal", defaultFormat: "rgba16float", clearValue: ZERO },
    { name: "WorldNormal", defaultFormat: "rgba16float", clearValue: ZERO },
    { name: "Albedo", defaultFormat: "rgba8unorm", clearValue: ZERO },
    { name: "LinearVelocity", defaultFormat: "rgba16float", clearValue: ZERO },
];
