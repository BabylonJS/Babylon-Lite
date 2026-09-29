import { createPbrMaterial, loadTexture2D, markMaterialUboDirty, type ComputeStorageTexture, type EngineContext, type PbrMaterialProps, type Texture2D } from "babylon-lite";
import type { OceanShaderColorParameter, OceanShaderNumberParameter } from "./controls.js";
import { createOceanMaterialPlugin, type OceanMaterialPlugin, type OceanMaterialPluginState } from "./material-plugin.js";
import type { OceanComputeResources } from "./resources.js";

const FOAM_TEXTURE_URL = "https://assets.babylonjs.com/environments/waterFoam_circular_mask.png";

export interface OceanMaterials {
    readonly close: PbrMaterialProps;
    readonly mid: PbrMaterialProps;
    readonly far: PbrMaterialProps;
    readonly all: readonly PbrMaterialProps[];
    update(turbulenceIndex: 0 | 1, timeSeconds: number): void;
    setFoamScale(value: number): void;
    setContactFoam(value: number): void;
    setDebugMode(value: number): void;
    setSunDirection(value: readonly [number, number, number]): void;
    setEnvironmentIntensity(value: number): void;
    setNumber(name: OceanShaderNumberParameter, value: number): void;
    setColor(name: OceanShaderColorParameter, value: string): void;
}

function sampled(resource: ComputeStorageTexture): Texture2D {
    if (!resource.sampledTexture) {
        throw new Error("Ocean render texture is not sampleable.");
    }
    return resource.sampledTexture;
}

function createVariant(plugin: OceanMaterialPlugin): PbrMaterialProps {
    return createPbrMaterial({
        metallicFactor: 0,
        roughnessFactor: 0.311,
        environmentIntensity: 1,
        directIntensity: 1,
        plugins: [plugin.plugin],
    });
}

function setStateNumber(material: PbrMaterialProps, state: OceanMaterialPluginState, name: OceanShaderNumberParameter, value: number): void {
    if (name === "maxGloss") {
        state.maxGloss = value;
    } else if (name === "roughnessScale") {
        state.roughnessScale = value;
    } else if (name === "lodScale") {
        state.lodScale = value;
    } else if (name === "foamScale") {
        state.foamScale = value;
    } else if (name === "contactFoam") {
        state.contactFoam = value;
    } else if (name === "foamBias") {
        state.foamBias = value;
    } else if (name === "sssStrength") {
        state.sssStrength = value;
    } else if (name === "sssBase") {
        state.sssBase = value;
    } else if (name === "sssScale") {
        state.sssScale = value;
    }
    markMaterialUboDirty(material);
}

function toLinearColor(value: string): [number, number, number] {
    return [(Number.parseInt(value.slice(1, 3), 16) / 255) ** 2.2, (Number.parseInt(value.slice(3, 5), 16) / 255) ** 2.2, (Number.parseInt(value.slice(5, 7), 16) / 255) ** 2.2];
}

export async function createOceanMaterials(
    engine: EngineContext,
    resources: OceanComputeResources,
    sceneDepth: Texture2D,
    cameraNearFar: readonly [number, number]
): Promise<OceanMaterials> {
    // Resolve every sampled compute output here so a missing sampled view fails
    // before the asynchronous foam load and material-plugin registration.
    for (const cascade of resources.cascades) {
        sampled(cascade.displacement);
        sampled(cascade.derivatives);
        sampled(cascade.turbulenceA);
        sampled(cascade.turbulenceB);
    }
    const foamTexture = await loadTexture2D(engine, FOAM_TEXTURE_URL);
    const closePlugin = createOceanMaterialPlugin(resources, sceneDepth, foamTexture, cameraNearFar, true, true, 2.72);
    const midPlugin = createOceanMaterialPlugin(resources, sceneDepth, foamTexture, cameraNearFar, true, false, 1.83);
    const farPlugin = createOceanMaterialPlugin(resources, sceneDepth, foamTexture, cameraNearFar, false, false, 0.84);
    const close = createVariant(closePlugin);
    const mid = createVariant(midPlugin);
    const far = createVariant(farPlugin);
    const entries = [
        { material: close, plugin: closePlugin },
        { material: mid, plugin: midPlugin },
        { material: far, plugin: farPlugin },
    ] as const;
    const all = [close, mid, far] as const;

    return {
        close,
        mid,
        far,
        all,
        update(turbulenceIndex: 0 | 1, timeSeconds: number): void {
            for (const entry of entries) {
                const state = entry.plugin.state;
                const time = timeSeconds / 10;
                const screenWidth = engine.canvas.width;
                const screenHeight = engine.canvas.height;
                if (state.turbulenceIndex !== turbulenceIndex || state.time !== time || state.screenWidth !== screenWidth || state.screenHeight !== screenHeight) {
                    state.turbulenceIndex = turbulenceIndex;
                    state.time = time;
                    state.screenWidth = screenWidth;
                    state.screenHeight = screenHeight;
                    markMaterialUboDirty(entry.material);
                }
            }
        },
        setFoamScale(value: number): void {
            for (const entry of entries) {
                entry.plugin.state.foamScale = value;
                markMaterialUboDirty(entry.material);
            }
        },
        setContactFoam(value: number): void {
            for (const entry of entries) {
                entry.plugin.state.contactFoam = value;
                markMaterialUboDirty(entry.material);
            }
        },
        setDebugMode(value: number): void {
            for (const entry of entries) {
                entry.plugin.state.debugMode = value;
                markMaterialUboDirty(entry.material);
            }
        },
        setSunDirection(value: readonly [number, number, number]): void {
            for (const entry of entries) {
                const direction = entry.plugin.state.lightDirection;
                direction[0] = -value[0];
                direction[1] = -value[1];
                direction[2] = -value[2];
                markMaterialUboDirty(entry.material);
            }
        },
        setEnvironmentIntensity(value: number): void {
            for (const material of all) {
                material.environmentIntensity = value;
                markMaterialUboDirty(material);
            }
        },
        setNumber(name: OceanShaderNumberParameter, value: number): void {
            if (name === "foamBias") {
                setStateNumber(close, closePlugin.state, name, value);
                return;
            }
            for (const entry of entries) {
                setStateNumber(entry.material, entry.plugin.state, name, value);
            }
        },
        setColor(name: OceanShaderColorParameter, value: string): void {
            const color = toLinearColor(value);
            for (const entry of entries) {
                const state = entry.plugin.state;
                const target = name === "waterColor" ? state.color : name === "foamColor" ? state.foamColor : state.sssColor;
                target[0] = color[0];
                target[1] = color[1];
                target[2] = color[2];
                markMaterialUboDirty(entry.material);
            }
        },
    };
}
