/** Shared scene 72 — fetches D8AK3Z#160 setup from the BJS playground.
 *  D8AK3Z#160 itself uses NME EPY8BV#6 (the full PBR-MR + Reflection +
 *  ClearCoat + Sheen + Anisotropy + SubSurface graph) on a sphere + ground
 *  with 4 lights (hemi + point + spot + directional with PCF shadow).
 */

const SNIPPET_URL = "https://snippet.babylonjs.com/EPY8BV/6";

export interface Scene72Snippet {
    json: object;
}

export async function fetchScene72Snippet(): Promise<Scene72Snippet> {
    const r = await fetch(SNIPPET_URL);
    if (!r.ok) {
        throw new Error(`Failed to fetch EPY8BV/6: ${r.status}`);
    }
    const outer = (await r.json()) as { jsonPayload: string };
    const inner = JSON.parse(outer.jsonPayload) as { nodeMaterial: string };
    const json = JSON.parse(inner.nodeMaterial) as object;
    return { json };
}
