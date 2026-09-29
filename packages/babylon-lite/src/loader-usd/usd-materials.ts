import type { EngineContext } from "../engine/engine.js";
import { createPbrMaterial } from "../material/pbr/pbr-material.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { UsdRecord } from "./usd-protocol.js";
import { USD_NONE, UsdOp, usdField, usdFloats, usdString } from "./usd-protocol.js";
import type { UsdMaterialBindings, UsdTextureBinding } from "./usd-material-plugin.js";

const RGB = 4;

function validateBinding(binding: UsdTextureBinding | undefined, scalar: boolean, label: string): void {
    if (!binding) {
        return;
    }
    if (scalar ? binding.channel < 0 || binding.channel > 3 : binding.channel !== RGB) {
        throw new Error(`Invalid USD ${label} texture output channel ${binding.channel}`);
    }
}

/** @internal Translate protocol-v5 Preview Surface factors and independent texture bindings. */
export async function buildUsdMaterials(
    engine: EngineContext,
    records: readonly UsdRecord[],
    data: ArrayBuffer,
    owned: Texture2D[],
    signal?: AbortSignal
): Promise<Map<number, PbrMaterialProps>> {
    const materials = new Map<number, PbrMaterialProps>();
    const hasTextures = records.some((record) => record.op === UsdOp.Texture);
    const textureModule = hasTextures ? await import("./usd-textures.js") : undefined;
    const loadTexture = textureModule?.createUsdTextureLoader(engine, records, data, owned, signal);
    let hasPlugins = false;
    for (const record of records) {
        if (record.op !== UsdOp.Material) {
            continue;
        }
        signal?.throwIfAborted();
        const id = usdField(record, 0);
        if (materials.has(id)) {
            throw new Error(`Duplicate USD material ${id}`);
        }
        const base = usdFloats(data, usdField(record, 3), 4);
        const emissive = usdFloats(data, usdField(record, 4), 3);
        const metallic = record.payload.getFloat32(20, true);
        const roughness = record.payload.getFloat32(24, true);
        const normalScale = record.payload.getFloat32(28, true);
        const cutoff = record.payload.getFloat32(32, true);
        if (![...base, ...emissive, metallic, roughness, normalScale, cutoff].every(Number.isFinite)) {
            throw new Error(`Non-finite USD material ${id}`);
        }
        const flags = usdField(record, 9);
        const textureIds = Array.from({ length: 7 }, (_, index) => usdField(record, 10 + index));
        const channels = Array.from({ length: 7 }, (_, index) => usdField(record, 17 + index));
        const binding = async (index: number): Promise<UsdTextureBinding | undefined> => {
            const textureId = textureIds[index]!;
            const channel = channels[index]!;
            if (textureId === USD_NONE) {
                if (channel !== USD_NONE) {
                    throw new Error(`USD material ${id} has a channel without texture ${index}`);
                }
                return undefined;
            }
            if (!loadTexture) {
                throw new Error(`USD material ${id} references texture ${textureId} without a texture command`);
            }
            return { source: await loadTexture(textureId), channel };
        };
        const pendingBindings = Array.from({ length: 7 }, (_, index) => binding(index));
        let all: Array<UsdTextureBinding | undefined>;
        try {
            all = await Promise.all(pendingBindings);
        } catch (error) {
            await Promise.allSettled(pendingBindings);
            throw error;
        }
        const [baseTexture, opacityTexture, normalTexture, metallicTexture, roughnessTexture, occlusionTexture, emissiveTexture] = all;
        validateBinding(baseTexture, false, "base-color");
        validateBinding(opacityTexture, true, "opacity");
        validateBinding(normalTexture, false, "normal");
        validateBinding(metallicTexture, true, "metallic");
        validateBinding(roughnessTexture, true, "roughness");
        validateBinding(occlusionTexture, true, "occlusion");
        validateBinding(emissiveTexture, false, "emissive");
        const pluginBindings: UsdMaterialBindings = {
            base: baseTexture,
            opacity: opacityTexture,
            normal: normalTexture,
            metallic: metallicTexture,
            roughness: roughnessTexture,
            occlusion: occlusionTexture,
            emissive: emissiveTexture,
        };
        const usesPlugin = Object.values(pluginBindings).some(Boolean);
        const mat = createPbrMaterial({
            name: usdString(data, usdField(record, 1), usdField(record, 2)),
            baseColorFactor: [base[0]!, base[1]!, base[2]!, base[3]!],
            alpha: 1,
            metallicFactor: metallic,
            roughnessFactor: roughness,
            normalTextureScale: normalScale,
            doubleSided: !!(flags & 1),
            alphaBlend: !!(flags & 4),
            occlusionStrength: occlusionTexture ? 1 : 0,
        });
        if (usesPlugin) {
            const { createUsdMaterialPlugin } = await import("./usd-material-plugin.js");
            mat.plugins = [createUsdMaterialPlugin(pluginBindings)];
            hasPlugins = true;
        }
        if (cutoff > 0) {
            mat.alphaBlend = false;
            (await import("../material/pbr/set-alpha-cutoff.js")).setPbrAlphaCutoff(mat, cutoff);
        }
        if (!emissiveTexture && emissive.some((value) => value !== 0)) {
            (await import("../material/pbr/set-emissive.js")).setPbrEmissive(mat, [emissive[0]!, emissive[1]!, emissive[2]!]);
        }
        if (flags & 2) {
            (await import("../material/pbr/set-unlit.js")).setPbrUnlit(mat);
        }
        materials.set(id, mat);
    }
    if (hasPlugins) {
        const [{ registerPbrPlugins }, { _registerPbrExt }] = await Promise.all([import("../material/plugin/pbr-plugin-bridge.js"), import("../material/pbr/pbr-flags.js")]);
        registerPbrPlugins(_registerPbrExt);
    }
    return materials;
}
