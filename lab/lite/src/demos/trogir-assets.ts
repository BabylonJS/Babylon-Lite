const METADATA_URL = "https://assets.babylonjs.com/splats/Trogir/lod-meta.json";
const COLLISION_URL = "https://d28zzqy0iyovbz.cloudfront.net/14bac5b2/v1/scene.voxel.json";

export function resolveTrogirAssets(pageUrl: string): { metadataUrl: string; collisionUrl: string } {
    const page = new URL(pageUrl);
    const configured = page.searchParams.get("assetRoot");
    const root = new URL(configured || METADATA_URL, page);
    if (!/^https?:$/.test(root.protocol)) {
        throw new Error("assetRoot must resolve to an HTTP(S) URL.");
    }
    if (!root.pathname.endsWith("/lod-meta.json")) {
        if (!root.pathname.endsWith("/")) {
            root.pathname += "/";
        }
        root.pathname += "lod-meta.json";
    }
    const collisionOverride = page.searchParams.get("collisionUrl");
    const isPublicDataset = root.origin + root.pathname === METADATA_URL;
    const collision = new URL(collisionOverride || (isPublicDataset ? COLLISION_URL : "scene.voxel.json"), collisionOverride ? page : root);
    if (!isPublicDataset && !collisionOverride) {
        collision.search = root.search;
    }
    if (!/^https?:$/.test(collision.protocol) || !collision.pathname.endsWith(".voxel.json")) {
        throw new Error("collisionUrl must resolve to an HTTP(S) .voxel.json URL.");
    }
    return { metadataUrl: root.href, collisionUrl: collision.href };
}
