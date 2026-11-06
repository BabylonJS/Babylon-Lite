import type { UboField } from "../../shader/fragment-types.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "../standard/standard-material.js";

/** Independently implemented contact-refinement parallax occlusion mapping.
 * Displaces surface texture coordinates, not mesh geometry or fragment depth. */
export interface ParallaxOcclusionProps {
    /** Filterable height texture. Use a linear format for RGB height channels. */
    readonly heightTexture: Texture2D;
    /** World-space height range. Default 0.05; zero disables displacement. */
    readonly heightScale?: number;
    /** Placement of the height range: 0 below the mesh, 1 above it. Default 0. */
    readonly heightCenter?: number;
    /** Channel containing height, clamped to [0, 1]. Default "r". */
    readonly heightChannel?: "r" | "g" | "b" | "a";
    /** Coarse-step budget at normal incidence; fewer steps are taken when the ray crosses fewer height texels. Integer [1, 64]. Default 8. */
    readonly minSteps?: number;
    /** Coarse-step budget at grazing incidence. Integer [minSteps, 64]. Default 32. */
    readonly maxSteps?: number;
    /** Maximum subdivisions of the first contact interval, reached by bisection and stopped once it spans one pixel. Integer [1, 32]. Default 8. */
    readonly refinementSteps?: number;
}

/** @internal */
export function _getParallaxHeightTexture(material: { readonly _parallaxOcclusion?: ParallaxOcclusionProps }): Texture2D | undefined {
    const props = material._parallaxOcclusion;
    return props && (props.heightScale ?? 0.05) !== 0 ? props.heightTexture : undefined;
}

/** @internal */
export function _getStandardParallaxHeightTexture(material: StandardMaterialProps): Texture2D | undefined {
    const height = _getParallaxHeightTexture(material);
    return height &&
        (material.diffuseTexture ||
            material._emissiveTexture ||
            material._bumpTexture ||
            material._specularTexture ||
            material._ambientTexture ||
            material._lightmapTexture ||
            material._opacityTexture)
        ? height
        : undefined;
}

/** @internal */
export const _PARALLAX_UBO_FIELDS: readonly UboField[] = [
    { _name: "parallaxHeight", _type: "vec4<f32>" },
    { _name: "parallaxSampling", _type: "vec4<f32>" },
    { _name: "parallaxUVm", _type: "vec4<f32>" },
    { _name: "parallaxUVt", _type: "vec4<f32>" },
];

function validateSteps(value: number, name: string, maximum: number): void {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(`Parallax ${name} must be an integer between 1 and ${maximum}.`);
    }
}

/** @internal Validate before changing material state or registering an extension. */
export function _copyParallaxOcclusionProps(props: ParallaxOcclusionProps): ParallaxOcclusionProps {
    if (!props?.heightTexture) {
        throw new TypeError("Parallax occlusion requires a heightTexture; pass null to the setter to disable it.");
    }
    const scale = props.heightScale ?? 0.05;
    if (!Number.isFinite(scale) || !Number.isFinite(Math.fround(scale)) || scale < 0) {
        throw new RangeError("Parallax heightScale must be finite, non-negative, and representable as f32.");
    }
    const center = props.heightCenter ?? 0;
    if (!Number.isFinite(center) || center < 0 || center > 1) {
        throw new RangeError("Parallax heightCenter must be between 0 and 1.");
    }
    const channel = props.heightChannel ?? "r";
    if (typeof channel !== "string" || channel.length !== 1 || !"rgba".includes(channel)) {
        throw new RangeError('Parallax heightChannel must be "r", "g", "b", or "a".');
    }
    const minSteps = props.minSteps ?? 8;
    const maxSteps = props.maxSteps ?? 32;
    validateSteps(minSteps, "minSteps", 64);
    validateSteps(maxSteps, "maxSteps", 64);
    validateSteps(props.refinementSteps ?? 8, "refinementSteps", 32);
    if (maxSteps < minSteps) {
        throw new RangeError("Parallax maxSteps must be greater than or equal to minSteps.");
    }
    const texture = props.heightTexture;
    const format = texture.texture.format;
    if (
        texture._sampleType === "depth" ||
        format.startsWith("depth") ||
        format === "stencil8" ||
        format.endsWith("uint") ||
        format.endsWith("sint") ||
        format === "r32float" ||
        format === "rg32float" ||
        format === "rgba32float"
    ) {
        throw new TypeError("Parallax heightTexture must use a filterable color format.");
    }
    if (channel !== "a" && format.endsWith("-srgb")) {
        throw new TypeError("Parallax RGB height channels require a linear texture format; sRGB textures may only use alpha.");
    }
    for (const name of ["uScale", "vScale", "uOffset", "vOffset", "uAng"] as const) {
        const value = texture[name];
        if (value !== undefined && (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
            throw new RangeError(`Parallax heightTexture.${name} must be finite and representable as f32.`);
        }
    }
    return { ...props };
}

/** @internal Write four vec4 fields at float offsets. The base transform may alias data; no per-update allocations. */
export function _writeParallaxUniforms(
    data: Float32Array,
    props: ParallaxOcclusionProps,
    heightOffset: number,
    samplingOffset: number,
    matrixOffset: number,
    translationOffset: number,
    baseTransform?: ArrayLike<number>,
    invertY = false
): void {
    const baseScaleX = baseTransform?.[0] ?? 1;
    const baseScaleY = baseTransform?.[1] ?? 1;
    const baseOffsetX = baseTransform?.[2] ?? 0;
    const baseOffsetY = baseTransform?.[3] ?? 0;
    data[heightOffset] = props.heightScale ?? 0.05;
    data[heightOffset + 1] = props.heightCenter ?? 0;
    data[heightOffset + 2] = 0;
    data[heightOffset + 3] = 0;
    data[samplingOffset] = props.minSteps ?? 8;
    data[samplingOffset + 1] = props.maxSteps ?? 32;
    data[samplingOffset + 2] = props.refinementSteps ?? 8;
    data[samplingOffset + 3] = "rgba".indexOf(props.heightChannel ?? "r");

    const texture = props.heightTexture;
    const c = Math.cos(texture.uAng ?? 0);
    const s = Math.sin(texture.uAng ?? 0);
    const sx = texture.uScale ?? 1;
    const sy = texture.vScale ?? 1;
    const m00 = c * sx;
    const m01 = s * sy;
    const m10 = -s * sx;
    const m11 = c * sy;
    data[matrixOffset] = m00 * baseScaleX;
    data[matrixOffset + 1] = m01 * baseScaleY;
    data[matrixOffset + 2] = m10 * baseScaleX;
    data[matrixOffset + 3] = m11 * baseScaleY;
    data[translationOffset] = m00 * baseOffsetX + m01 * baseOffsetY + (texture.uOffset ?? 0);
    data[translationOffset + 1] = m10 * baseOffsetX + m11 * baseOffsetY + (texture.vOffset ?? 0);
    data[translationOffset + 2] = 0;
    data[translationOffset + 3] = 0;
    if (invertY) {
        data[matrixOffset + 2] = -data[matrixOffset + 2]!;
        data[matrixOffset + 3] = -data[matrixOffset + 3]!;
        data[translationOffset + 1] = 1 - data[translationOffset + 1]!;
    }
}
