export const SSAO_BASELINE = {
    repository: "BabylonJS/Babylon-Lite",
    commit: "29b75909635efc1d6d15795da561a78cced5fc19",
    pullRequest: "https://github.com/BabylonJS/Babylon-Lite/pull/839",
    blobs: {
        "screen-space-ambient-occlusion.ts": "8114833895f125b68d72cc44c3f3d0e4f5f29e0c",
        "screen-space-raymarch-wgsl.ts": "9be3c5018d7115c1f7bac592d11018a092ef3b1b",
        "screen-space-temporal.ts": "9d4e7c7ad78b2ca1470481073df9ef3e7bd38cb4",
    },
} as const;

export const SSAO_COMPARISON_SCENES = [
    { id: "contacts", name: "Contacts and corners" },
    { id: "layers", name: "Thin and overlapping geometry" },
    { id: "motion", name: "Motion, skinning and morphing" },
    { id: "cornell", name: "Cornell Box" },
    { id: "kitchen", name: "Diligent Kitchen (original colors)" },
] as const;

export type ComparisonScene = (typeof SSAO_COMPARISON_SCENES)[number]["id"];
export type ComparisonAlgorithm = "current" | "existing";
export type ComparisonMode = "split" | "single";
export interface SsaoComparisonConfig {
    scene: ComparisonScene;
    algorithm: ComparisonAlgorithm;
    mode: ComparisonMode;
    aoOnly: boolean;
    enabled: boolean;
    temporal: boolean;
    normals: boolean;
    half: boolean;
    reconstruction: "full" | "half";
    pruning: boolean;
    quality: "low" | "medium" | "high" | "ultra";
    radius: number;
    intensity: number;
}

export function parseSsaoComparisonConfig(params: URLSearchParams): SsaoComparisonConfig {
    const scene = params.get("scene") ?? "contacts";
    const algorithm = params.get("algorithm") ?? "current";
    const mode = params.get("mode") ?? "split";
    const quality = params.get("quality") ?? "high";
    const reconstruction = params.get("reconstruction") ?? "full";
    if (reconstruction !== "full" && reconstruction !== "half") {
        throw new Error(`Unknown XeGTAO reconstruction: ${reconstruction}`);
    }
    if (quality !== "low" && quality !== "medium" && quality !== "high" && quality !== "ultra") {
        throw new Error(`Unknown XeGTAO quality: ${quality}`);
    }
    const number = (name: string, fallback: number, min: number, max: number): number => {
        const text = params.get(name);
        if (text !== null && !text.trim()) {
            throw new Error(`SSAO comparison ${name} cannot be empty.`);
        }
        const value = text === null ? fallback : Number(text);
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new Error(`SSAO comparison ${name} must be in [${min}, ${max}].`);
        }
        return value;
    };
    if (!SSAO_COMPARISON_SCENES.some((preset) => preset.id === scene)) {
        throw new Error(`Unknown SSAO comparison scene: ${scene}`);
    }
    if (algorithm !== "current" && algorithm !== "existing") {
        throw new Error(`Unknown SSAO comparison algorithm: ${algorithm}`);
    }
    if (mode !== "split" && mode !== "single") {
        throw new Error(`Unknown SSAO comparison mode: ${mode}`);
    }
    const flag = (name: string, fallback: boolean): boolean => {
        const value = params.get(name);
        if (value === null) {
            return fallback;
        }
        if (value !== "0" && value !== "1") {
            throw new Error(`SSAO comparison ${name} must be 0 or 1.`);
        }
        return value === "1";
    };
    return {
        scene: scene as ComparisonScene,
        algorithm,
        mode,
        aoOnly: flag("ao", true),
        enabled: flag("ssao", true),
        temporal: flag("temporal", true),
        normals: flag("normals", true),
        half: flag("half", true),
        reconstruction,
        pruning: flag("pruning", true),
        quality,
        radius: number("radius", 0.6, 0.05, 2),
        intensity: number("intensity", 0.5, 0, 1),
    };
}

export function comparisonPassSelection(config: Pick<SsaoComparisonConfig, "algorithm" | "mode" | "normals" | "temporal" | "enabled">) {
    const current = config.enabled && (config.mode === "split" || config.algorithm === "current");
    const existing = config.enabled && (config.mode === "split" || config.algorithm === "existing");
    const geometry = current && (config.normals || config.temporal);
    return { current, existing, geometry, color: !geometry, timing: config.mode === "single" };
}
