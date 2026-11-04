export const SCENE349_ASSETS = {
    stone: {
        color: "https://i.imgur.com/VSbN3Fc.png",
        normalHeight: "https://i.imgur.com/zVGaZNi.png",
    },
    wall: {
        color: "https://i.imgur.com/Rkh1uFK.png",
        normalHeight: "https://i.imgur.com/GtIUsWW.png",
    },
} as const;
export const SCENE349_PANEL_SIZE = 2.4;
export const SCENE349_CLEAR_COLOR = [0.035, 0.045, 0.065, 1] as const;
export const SCENE349_LIGHT_DIRECTION = [-0.35, -0.55, 1] as const;
export const SCENE349_PANELS = [
    { name: "standard-control", family: "standard", pom: false, x: -1.35, y: 1.35 },
    { name: "standard-pom", family: "standard", pom: true, x: 1.35, y: 1.35 },
    { name: "pbr-control", family: "pbr", pom: false, x: -1.35, y: -1.35 },
    { name: "pbr-pom", family: "pbr", pom: true, x: 1.35, y: -1.35 },
] as const;

export const SCENE349_CAMERAS = {
    front: { alpha: -Math.PI / 2, beta: Math.PI / 2, radius: 7.8 },
    oblique: { alpha: -Math.PI / 2 + 0.48, beta: 1.36, radius: 7.8 },
    grazing: { alpha: -Math.PI / 2 + 1.02, beta: 1.42, radius: 8.4 },
} as const;

export const SCENE349_QUALITY = {
    low: { minSteps: 4, maxSteps: 8, refinementSteps: 4 },
    medium: { minSteps: 8, maxSteps: 32, refinementSteps: 8 },
    high: { minSteps: 16, maxSteps: 64, refinementSteps: 16 },
} as const;

export interface Scene349Settings {
    readonly pom: boolean;
    readonly depth: number;
    readonly view: keyof typeof SCENE349_CAMERAS;
    readonly asset: keyof typeof SCENE349_ASSETS;
    readonly quality: keyof typeof SCENE349_QUALITY;
    readonly embed: boolean;
}

export interface Scene349CameraPose {
    alpha: number;
    beta: number;
    radius: number;
}

export function readScene349Settings(search: string): Scene349Settings {
    const query = new URLSearchParams(search);
    const pom = query.get("pom") ?? "on";
    const view = query.get("view") ?? "grazing";
    const asset = query.get("asset") ?? "stone";
    const quality = query.get("quality") ?? "medium";
    const depth = Number(query.get("depth") ?? 0.06);
    if (pom !== "on" && pom !== "off") {
        throw new Error("Scene 349 pom must be on or off.");
    }
    if (view !== "front" && view !== "oblique" && view !== "grazing") {
        throw new Error("Scene 349 view must be front, oblique, or grazing.");
    }
    if (asset !== "stone" && asset !== "wall") {
        throw new Error("Scene 349 asset must be stone or wall.");
    }
    if (quality !== "low" && quality !== "medium" && quality !== "high") {
        throw new Error("Scene 349 quality must be low, medium, or high.");
    }
    if (!Number.isFinite(depth) || depth < 0 || depth > 0.16) {
        throw new RangeError("Scene 349 depth must be between 0 and 0.16.");
    }
    return { pom: pom === "on", view, asset, quality, depth, embed: query.get("embed") === "1" };
}

export function scene349Query(settings: Scene349Settings, embed = settings.embed): string {
    return new URLSearchParams({
        pom: settings.pom ? "on" : "off",
        depth: String(settings.depth),
        view: settings.view,
        asset: settings.asset,
        quality: settings.quality,
        ...(embed ? { embed: "1" } : {}),
    }).toString();
}

export function isScene349CameraPose(value: unknown): value is Scene349CameraPose {
    if (!value || typeof value !== "object") {
        return false;
    }
    const pose = value as Record<string, unknown>;
    return (
        typeof pose.alpha === "number" &&
        Number.isFinite(pose.alpha) &&
        pose.alpha >= -Math.PI + 0.15 &&
        pose.alpha <= -0.15 &&
        typeof pose.beta === "number" &&
        Number.isFinite(pose.beta) &&
        pose.beta >= 0.35 &&
        pose.beta <= Math.PI - 0.35 &&
        typeof pose.radius === "number" &&
        Number.isFinite(pose.radius) &&
        pose.radius >= 5.5 &&
        pose.radius <= 25
    );
}
