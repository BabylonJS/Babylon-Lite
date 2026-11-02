/**
 * Restore the SSAO comparison's Kitchen scene from an immutable BabylonJS/Assets revision.
 * The 13 MB GLB stays out of this repository; its Apache-2.0 license and source manifest are
 * kept beside it in `lab/public/ssao-comparison/`. The manifest's size and SHA-256 are verified
 * even on cache hits, so a partial or stale download cannot reach the browser or reference tools.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SSAO_KITCHEN_PATH = join(ROOT, "lab/public/ssao-comparison/kitchen.glb");
export const SSAO_KITCHEN_URL = "https://raw.githubusercontent.com/BabylonJS/Assets/0f2240a3819007ce3aa92f22f0955f0f20dbbe59/meshes/DiligentKitchen/kitchen.glb";
const SSAO_KITCHEN_SOURCE = join(dirname(SSAO_KITCHEN_PATH), "kitchen-source.json");

function matchesSource(bytes: Uint8Array, source: { glbBytes: number; glbSha256: string }): boolean {
    return bytes.byteLength === source.glbBytes && createHash("sha256").update(bytes).digest("hex") === source.glbSha256;
}

/** Download `kitchen.glb` unless the local copy already matches the checked-in `kitchen-source.json`. */
export async function fetchSsaoKitchen(): Promise<void> {
    const source = JSON.parse(readFileSync(SSAO_KITCHEN_SOURCE, "utf8")) as { glbBytes: number; glbSha256: string };
    if (existsSync(SSAO_KITCHEN_PATH) && matchesSource(readFileSync(SSAO_KITCHEN_PATH), source)) {
        return;
    }
    let bytes: Uint8Array;
    try {
        const response = await fetch(SSAO_KITCHEN_URL, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        throw new Error(`SSAO Kitchen download failed: ${SSAO_KITCHEN_URL}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!matchesSource(bytes, source)) {
        throw new Error(`SSAO Kitchen integrity check failed: ${SSAO_KITCHEN_URL}`);
    }
    const temp = `${SSAO_KITCHEN_PATH}.${process.pid}.tmp`;
    try {
        mkdirSync(dirname(SSAO_KITCHEN_PATH), { recursive: true });
        writeFileSync(temp, bytes);
        renameSync(temp, SSAO_KITCHEN_PATH);
    } finally {
        rmSync(temp, { force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchSsaoKitchen().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
