const DEFAULT_SNIPPET_SERVER = "https://snippet.babylonjs.com";

export async function fetchSnippetSource(snippetId: string, server: string = DEFAULT_SNIPPET_SERVER): Promise<unknown> {
    const [id, version] = snippetId.split("#");
    const url = version ? `${server}/${id}/${version}` : `${server}/${id}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`NodeMaterial: snippet fetch failed (${resp.status}) for ${url}`);
    }
    const outer = (await resp.json()) as { jsonPayload?: string };
    if (!outer.jsonPayload) {
        throw new Error(`NodeMaterial: snippet "${snippetId}" has no jsonPayload`);
    }
    const inner = JSON.parse(outer.jsonPayload) as { nodeMaterial?: string };
    if (!inner.nodeMaterial) {
        throw new Error(`NodeMaterial: snippet "${snippetId}" has no nodeMaterial`);
    }
    return JSON.parse(inner.nodeMaterial);
}
