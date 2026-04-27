/** Scene 66 — full NME playground AT7YY5#6 from PG M5VQE9#45.
 *
 *  The graph has 136 blocks (PBR-style with diffuse/ambient/specular/emissive/
 *  normal/opacity/lightmap textures + equirect reflection) plus instances,
 *  bones, morph targets, front-facing, and PCF shadow receive.
 *
 *  Both Lite and BJS reference pages fetch the snippet at runtime and decode
 *  the embedded base64 textures. Morph scramble deltas are generated from a
 *  seeded mulberry32 PRNG so both pages get the exact same perturbed sphere.
 */

export const SCENE66_SNIPPET_ID = "AT7YY5#6";
export const SCENE66_SNIPPET_URL = "https://snippet.babylonjs.com/AT7YY5/6";
export const SCENE66_MORPH_PERIOD_MS = 6283.185; // 2π seconds — angle += 0.01/frame at 60Hz

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

/** Generate a deterministic scramble delta array matching PG's scrambleUp
 *  (which did `data[i] += 0.4 * Math.random()` per position component). We
 *  replace Math.random with mulberry32 so Lite + BJS see the same deltas. */
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
    /** Block name (unsanitized — caller may sanitize for Lite's binding keys). */
    readonly name: string;
    /** Block className (TextureBlock / ReflectionTextureBlock / ...). */
    readonly className: string;
    /** Data URL (or plain URL) embedded in the snippet. */
    readonly url: string;
    readonly coordinatesMode?: number;
    readonly invertY?: boolean;
    readonly hasAlpha?: boolean;
    /** BJS serialised texture.gammaSpace — true means texel data is stored in
     *  sRGB/gamma space and must be decoded on sample. Lite maps this onto the
     *  loader's `srgb` flag so TextureBlocks match BJS's sampled values. */
    readonly gammaSpace?: boolean;
}

/** Fetch + parse the scene 66 snippet. Returns the raw `nodeMaterial` JSON
 *  object plus an index of texture-bearing blocks so the caller can pre-load
 *  embedded images. */
export async function fetchScene66Snippet(): Promise<{ json: unknown; textures: SnippetTextureInfo[] }> {
    const resp = await fetch(SCENE66_SNIPPET_URL);
    if (!resp.ok) {
        throw new Error(`scene66: snippet fetch failed (${resp.status})`);
    }
    const outer = (await resp.json()) as { jsonPayload?: string };
    if (!outer.jsonPayload) {
        throw new Error("scene66: snippet has no jsonPayload");
    }
    const inner = JSON.parse(outer.jsonPayload) as { nodeMaterial?: string };
    if (!inner.nodeMaterial) {
        throw new Error("scene66: snippet has no nodeMaterial");
    }
    const json = JSON.parse(inner.nodeMaterial);

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
            name: (b["name"] as string) ?? `tex${b["id"]}`,
            className: cls,
            url: tex.url,
            coordinatesMode: tex.coordinatesMode,
            invertY: tex.invertY,
            hasAlpha: tex.hasAlpha,
            gammaSpace: tex.gammaSpace,
        });
    }

    return { json, textures };
}

export function sanitizeName(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}
