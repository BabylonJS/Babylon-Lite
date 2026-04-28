export async function decodeGzipBase64Json<T>(encoded: string): Promise<T> {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return (await new Response(stream).json()) as T;
}

export function restoreInputNameAliases<T extends Record<string, unknown>>(json: T): T {
    const blocks = json.blocks;
    if (!Array.isArray(blocks)) {
        return json;
    }
    for (const block of blocks) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const inputs = (block as { inputs?: unknown }).inputs;
        if (!Array.isArray(inputs)) {
            continue;
        }
        for (const input of inputs) {
            if (!input || typeof input !== "object") {
                continue;
            }
            const entry = input as { name?: unknown; inputName?: unknown };
            if (entry.inputName === undefined && typeof entry.name === "string") {
                entry.inputName = entry.name;
            }
        }
    }
    return json;
}
