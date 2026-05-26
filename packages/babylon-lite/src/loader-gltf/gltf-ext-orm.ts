/** ORM compositing — packs separate metallic-roughness + occlusion bitmaps
 *  into a single ORM texture (R=occlusion, G=roughness, B=metallic).
 *
 *  Loaded only when the asset has at least one material with both a
 *  metallicRoughnessTexture and a separate occlusionTexture — see the
 *  `needs()` gate in load-gltf.ts. Materials that already ship packed ORM (or
 *  no occlusion at all) take the core's default ORM upload path and never hit
 *  this module. */
import type { GltfFeature } from "./gltf-feature.js";

async function compositeOrm(mr: ImageBitmap, occ: ImageBitmap): Promise<ImageBitmap> {
    const w = mr.width;
    const h = mr.height;
    const c1 = new OffscreenCanvas(w, h);
    const x1 = c1.getContext("2d")!;
    x1.drawImage(mr, 0, 0, w, h);
    const d1 = x1.getImageData(0, 0, w, h);
    const c2 = new OffscreenCanvas(w, h);
    const x2 = c2.getContext("2d")!;
    x2.drawImage(occ, 0, 0, w, h);
    const d2 = x2.getImageData(0, 0, w, h);
    for (let j = 0; j < d1.data.length; j += 4) {
        d1.data[j] = d2.data[j]!;
    }
    x1.putImageData(d1, 0, 0);
    return createImageBitmap(c1);
}

const ext: GltfFeature = {
    id: "_orm-composite",
    async applyMaterial(mat, ctx) {
        const mr = mat._metallicRoughnessImage;
        const occ = mat._occlusionImage;
        if (!mr || !occ || mr === occ) {
            return null;
        }
        const bmp = await compositeOrm(mr, occ);
        return { ormTexture: ctx._uploadImage(bmp, false) };
    },
};
export default ext;
