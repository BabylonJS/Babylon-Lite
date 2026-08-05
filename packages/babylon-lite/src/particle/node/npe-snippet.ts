/** Fetch a node-particle graph from the Babylon snippet server and unwrap the nested `nodeParticle` payload. */
export async function fetchNodeParticleSnippet(snippetId: string, server = "https://snippet.babylonjs.com"): Promise<unknown> {
    const id = snippetId.replace(/#/g, "/");
    const response = await fetch(`${server}/${id}`);
    if (!response.ok) {
        throw new Error(`NodeParticle: snippet fetch failed (${response.status})`);
    }
    const snippet = (await response.json()) as { jsonPayload: string };
    const payload = JSON.parse(snippet.jsonPayload) as { nodeParticle: string | object };
    const nodeParticle = payload.nodeParticle;
    return typeof nodeParticle === "string" ? JSON.parse(nodeParticle) : nodeParticle;
}
