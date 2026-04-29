import { decodeGzipBase64Json, restoreInputNameAliases } from "./nme-compression.js";

/** Scene 66 - full local NME playground AT7YY5#6 from PG M5VQE9#45.
 *
 * The graph has 136 blocks (PBR-style with diffuse/ambient/specular/emissive/
 * normal/opacity/lightmap textures + equirect reflection) plus instances,
 * bones, morph targets, front-facing, and PCF shadow receive.
 *
 * Both Lite and BJS reference pages use this checked-in NME JSON and load the
 * extracted local texture assets. Morph scramble deltas are generated from a seeded
 * mulberry32 PRNG so both pages get the exact same perturbed sphere.
 */

export const SCENE66_SNIPPET_ID = "AT7YY5#6";
export const SCENE66_MORPH_PERIOD_MS = 6283.185; // 2*pi seconds - angle += 0.01/frame at 60Hz

/** Simple deterministic PRNG used to generate scramble deltas on both sides. */
function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

/** Generate a deterministic scramble delta array matching PG's scrambleUp. */
export function sphereScrambleDeltas(vertexCount: number, seed = 0xabcdef01): Float32Array {
    const rand = mulberry32(seed);
    const deltas = new Float32Array(vertexCount * 3);
    for (let i = 0; i < deltas.length; i++) {
        deltas[i] = 0.4 * rand();
    }
    return deltas;
}

/** Shape of a texture override to hand to parseNodeMaterialFromSnippet. */
export interface SnippetTextureInfo {
    /** Block name (unsanitized - caller may sanitize for Lite's binding keys). */
    readonly name: string;
    /** Block className (TextureBlock / ReflectionTextureBlock / ...). */
    readonly className: string;
    /** Local texture asset URL referenced by the NME JSON. */
    readonly url: string;
    readonly coordinatesMode?: number;
    readonly invertY?: boolean;
    readonly hasAlpha?: boolean;
    /** BJS serialized texture.gammaSpace flag. */
    readonly gammaSpace?: boolean;
}

function getScene66TextureInfos(json: Record<string, unknown>): SnippetTextureInfo[] {
    const textures: SnippetTextureInfo[] = [];
    const blocks = (json as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
    for (const b of blocks) {
        const ct = (b["customType"] as string | undefined) ?? "";
        const cls = ct.startsWith("BABYLON.") ? ct.slice("BABYLON.".length) : ct;
        if (cls !== "TextureBlock" && cls !== "ReflectionTextureBlock") {
            continue;
        }
        const tex = b["texture"] as { url?: string; coordinatesMode?: number; invertY?: boolean; hasAlpha?: boolean; gammaSpace?: boolean } | undefined;
        if (!tex?.url) {
            continue;
        }
        textures.push({
            name: (b["name"] as string | undefined) ?? "tex" + String(b["id"]),
            className: cls,
            url: tex.url,
            coordinatesMode: tex.coordinatesMode,
            invertY: tex.invertY,
            hasAlpha: tex.hasAlpha,
            gammaSpace: tex.gammaSpace,
        });
    }
    return textures;
}

export function sanitizeName(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

const SCENE66_NME_GZIP_BASE64 = "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";

export async function getScene66Nme(): Promise<{ json: Record<string, unknown>; textures: SnippetTextureInfo[] }> {
    const json = restoreInputNameAliases(await decodeGzipBase64Json<Record<string, unknown>>(SCENE66_NME_GZIP_BASE64));
    return { json, textures: getScene66TextureInfos(json) };
}
