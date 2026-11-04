/**
 * Restore scene 112's KTX2 fixture from an immutable BabylonJS/Assets revision.
 * Keep the binary payload out of this repository and verify Git blob digests
 * even on cache hits, so a partial or stale download cannot reach the browser.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = join(ROOT, "lab/public/models/FlightHelmetKTX");
const SOURCE = "https://raw.githubusercontent.com/BabylonJS/Assets/183f26290601abe1d5282eed00c306f4c8228307/meshes/FlightHelmetKTX";

export const FLIGHT_HELMET_FILES = [
    ["FlightHelmet.gltf", "601641f97c0d12c2941e2ad226dcd2b74379c4c0"],
    ["FlightHelmet.bin", "21ed380f8164a3bcebbe5b02faded542dd0c0d83"],
    ["FlightHelmet_Materials_GlassPlasticMat_BaseColor.ktx2", "132363819a67fc85ce2211e85c1d8aae8422cce0"],
    ["FlightHelmet_Materials_GlassPlasticMat_Normal.ktx2", "36fe386a307652e9025d91c42ecb16ae30ba216e"],
    ["FlightHelmet_Materials_GlassPlasticMat_OcclusionRoughMetal.ktx2", "4826abe61c983d432dee776a026a7b30f2fc4edd"],
    ["FlightHelmet_Materials_LeatherPartsMat_BaseColor.ktx2", "13af070913c398164409959fa36f1153a812ad02"],
    ["FlightHelmet_Materials_LeatherPartsMat_Normal.ktx2", "9569b714d1dcddabe4f5ee0e4035aa47b8f05438"],
    ["FlightHelmet_Materials_LeatherPartsMat_OcclusionRoughMetal.ktx2", "da090fb5cfb6574d34e938d872820b9ec9ff04e7"],
    ["FlightHelmet_Materials_LensesMat_BaseColor.ktx2", "67ad6599ac0647a66e8cdc5d02f3f032e275503d"],
    ["FlightHelmet_Materials_LensesMat_Normal.ktx2", "ac58bed5defacc92bfebe471e2c6d269de051c20"],
    ["FlightHelmet_Materials_LensesMat_OcclusionRoughMetal.ktx2", "91aeabfb8328eaa5ab8bd2c0833f6ace875c86f1"],
    ["FlightHelmet_Materials_MetalPartsMat_BaseColor.ktx2", "07953a3a51e7148dcb7f9b56fb6604dd36c0afe9"],
    ["FlightHelmet_Materials_MetalPartsMat_Normal.ktx2", "9f3736167d32be604aa8534bf9e4160281844523"],
    ["FlightHelmet_Materials_MetalPartsMat_OcclusionRoughMetal.ktx2", "d8cf7e274df9f04d9dd5a746085d0318a5d1169b"],
    ["FlightHelmet_Materials_RubberWoodMat_BaseColor.ktx2", "83b94ce5964843241f77a13991a5384c5f634096"],
    ["FlightHelmet_Materials_RubberWoodMat_Normal.ktx2", "8e36531787a9ab055d55b51e753f682bfb53b877"],
    ["FlightHelmet_Materials_RubberWoodMat_OcclusionRoughMetal.ktx2", "befe80aab610f5c31a3e160c4ebbf69c06d7723b"],
] as const;

function blobDigest(bytes: Uint8Array): string {
    return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export async function fetchFlightHelmet(): Promise<void> {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    // Four independent downloads at a time avoid serial cold-start latency
    // without creating an unbounded burst of asset requests.
    for (let offset = 0; offset < FLIGHT_HELMET_FILES.length; offset += 4) {
        const results = await Promise.allSettled(
            FLIGHT_HELMET_FILES.slice(offset, offset + 4).map(async ([name, digest]) => {
                const dest = join(OUTPUT_DIR, name);
                if (existsSync(dest) && blobDigest(readFileSync(dest)) === digest) {
                    return;
                }
                const url = `${SOURCE}/${name}`;
                let bytes: Uint8Array;
                try {
                    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    bytes = new Uint8Array(await response.arrayBuffer());
                } catch (error) {
                    throw new Error(`Flight Helmet asset download failed: ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
                if (blobDigest(bytes) !== digest) {
                    throw new Error(`Flight Helmet asset integrity check failed: ${url}`);
                }
                const temp = `${dest}.${process.pid}.tmp`;
                try {
                    writeFileSync(temp, bytes);
                    renameSync(temp, dest);
                } finally {
                    rmSync(temp, { force: true });
                }
            })
        );
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) {
            throw failed.reason;
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchFlightHelmet().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
