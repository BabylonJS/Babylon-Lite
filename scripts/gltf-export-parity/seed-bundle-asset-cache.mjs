/**
 * Temporary handoff tooling for the glTF-export parity scenes — delete before merging.
 *
 * Seeds the bundle measurer's on-disk asset cache (.bundle-asset-cache, read by scripts/bundle-scenes-core.ts) from the
 * mirror built by build-asset-mirror.sh, so `BUNDLE_SOFTWARE_RENDER=1 pnpm exec tsx scripts/build-bundle-scenes.ts --scenes sceneN`
 * can measure scenes that load remote assets in a sandbox that cannot reach the asset hosts.
 *
 * Usage (repo root): node scripts/gltf-export-parity/seed-bundle-asset-cache.mjs [workDir]
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const work = process.argv[2] ?? process.env.GLTF_PARITY_WORK ?? path.join(os.homedir(), ".cache/gltf-parity");
const mirror = path.join(work, "mirror");
const cache = process.env.BUNDLE_ASSET_CACHE_DIR ?? ".bundle-asset-cache";
const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".ktx2": "image/ktx2", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".json": "application/json" };

function* walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
            yield* walk(full);
        } else {
            yield full;
        }
    }
}

fs.mkdirSync(cache, { recursive: true });
let count = 0;
for (const file of walk(mirror)) {
    const [host, ...rest] = path.relative(mirror, file).split(path.sep);
    const url = `https://${host}/${rest.join("/")}`;
    const key = createHash("sha256").update(url).digest("hex");
    fs.copyFileSync(file, path.join(cache, key));
    fs.writeFileSync(path.join(cache, `${key}.json`), JSON.stringify({ url, status: 200, contentType: types[path.extname(file).toLowerCase()] ?? "application/octet-stream" }));
    count++;
}
console.log(`seeded ${count} assets into ${cache}`);
