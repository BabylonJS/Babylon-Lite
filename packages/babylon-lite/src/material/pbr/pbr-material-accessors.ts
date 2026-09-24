import type { AnisotropyProps, ClearCoatProps, IridescenceProps, PbrMaterialProps, RefractionProps, SheenProps, SubSurfaceProps } from "./pbr-material.js";
import type { MetallicReflectanceOptions } from "./set-metallic-reflectance.js";

export interface PbrShadowOnly {
    readonly color: readonly [number, number, number];
    readonly opacity: number;
    readonly falloff: number;
}

const defaultUnlitColor = [1, 1, 1] as const;
const defaultShadowOnly = {
    color: [0, 0, 0] as const,
    opacity: 1,
    falloff: 1,
} as const satisfies PbrShadowOnly;

export function getPbrAlphaCutoff(material: PbrMaterialProps): number | undefined {
    return material._alphaCutOff;
}

export function getPbrEmissiveColor(material: PbrMaterialProps): readonly [number, number, number] | undefined {
    return material._emissiveColor;
}

export function getPbrMetallicReflectance(material: PbrMaterialProps): Readonly<MetallicReflectanceOptions> | undefined {
    if (
        material._metallicReflectanceColor === undefined &&
        material._metallicReflectanceTexture === undefined &&
        material._reflectanceTexture === undefined &&
        material._metallicF0Factor === undefined &&
        material._specularWeight === undefined &&
        material._useOnlyMetallicFromMetallicReflectanceTexture === undefined
    ) {
        return undefined;
    }
    return {
        color: material._metallicReflectanceColor,
        texture: material._metallicReflectanceTexture,
        reflectanceTexture: material._reflectanceTexture,
        f0Factor: material._metallicF0Factor,
        specularWeight: material._specularWeight,
        useOnlyMetallicFromTexture: material._useOnlyMetallicFromMetallicReflectanceTexture,
    };
}

export function getPbrClearCoat(material: PbrMaterialProps): Readonly<ClearCoatProps> | undefined {
    return material._clearCoat;
}

export function getPbrSheen(material: PbrMaterialProps): Readonly<SheenProps> | undefined {
    return material._sheen;
}

export function getPbrIridescence(material: PbrMaterialProps): Readonly<IridescenceProps> | undefined {
    return material._iridescence;
}

export function getPbrAnisotropy(material: PbrMaterialProps): Readonly<AnisotropyProps> | undefined {
    return material._anisotropy;
}

export function getPbrSubsurface(material: PbrMaterialProps): Readonly<SubSurfaceProps> | undefined {
    return material._subsurface;
}

export function getPbrTransmission(material: PbrMaterialProps): Readonly<RefractionProps> | undefined {
    return material._transmissive ? material._subsurface?.refraction : undefined;
}

export function getPbrDispersion(material: PbrMaterialProps): number | undefined {
    return material._subsurface?.refraction?.dispersion;
}

export function isPbrGammaAlbedo(material: PbrMaterialProps): boolean {
    return material._gammaAlbedo === true;
}

export function getPbrUnlit(material: PbrMaterialProps): readonly [number, number, number] | undefined {
    return material._unlit === true ? (material._unlitColor ?? defaultUnlitColor) : undefined;
}

export function isPbrSkybox(material: PbrMaterialProps): boolean {
    return material._skyboxMode === true;
}

export function getShadowOnly(material: PbrMaterialProps): PbrShadowOnly | undefined {
    if (material._shadowOnly !== true) {
        return undefined;
    }
    if (material._shadowOnlyColor === undefined && material._shadowOnlyOpacity === undefined && material._shadowOnlyFalloff === undefined) {
        return defaultShadowOnly;
    }
    return {
        color: material._shadowOnlyColor ?? defaultShadowOnly.color,
        opacity: material._shadowOnlyOpacity ?? 1,
        falloff: material._shadowOnlyFalloff ?? 1,
    };
}
