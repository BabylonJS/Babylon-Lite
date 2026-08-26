// Quick structural analysis of the staged Lottie anims: counts layer types and shape-item
// types so we know which files exercise strokes ("st"), gradient strokes ("gs"), images,
// mattes (tt/td), etc. — to pick the right visual test for each feature.
//   node demo/analyze.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const anims = resolve(here, "..", "anims");
const names = existsSync(anims)
    ? readdirSync(anims)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
    : [];

const LAYER_TY = { 0: "precomp", 1: "solid", 2: "image", 3: "null", 4: "shape", 5: "text" };

function walkItems(items, counts) {
    for (const it of items || []) {
        counts.item[it.ty] = (counts.item[it.ty] || 0) + 1;
        if (it.ty === "gr") {
            walkItems(it.it, counts);
        }
    }
}

for (const name of names) {
    const file = resolve(anims, `${name}.json`);
    if (!existsSync(file)) {
        continue;
    }
    const j = JSON.parse(readFileSync(file, "utf8"));
    const counts = { layer: {}, item: {}, matte: 0, maskLayers: 0, maskPaths: 0, maskModes: {} };
    for (const layer of j.layers || []) {
        const t = LAYER_TY[layer.ty] || layer.ty;
        counts.layer[t] = (counts.layer[t] || 0) + 1;
        if (layer.tt !== undefined || layer.td !== undefined) {
            counts.matte++;
        }
        // Layer masks: masksProperties[] with a per-mask mode `mode` (a/s/i/l/d/f = add/subtract/
        // intersect/lighten/darken/difference) and inverted flag `inv`.
        const masks = layer.masksProperties || layer.maskProperties;
        if (Array.isArray(masks) && masks.length > 0) {
            counts.maskLayers++;
            for (const m of masks) {
                counts.maskPaths++;
                const mode = (m.mode || "a") + (m.inv ? "(inv)" : "");
                counts.maskModes[mode] = (counts.maskModes[mode] || 0) + 1;
            }
        }
        if (layer.shapes) {
            walkItems(layer.shapes, counts);
        }
    }
    const fmt = (o) =>
        Object.entries(o)
            .map(([k, v]) => `${k}:${v}`)
            .join(" ");
    console.log(`\n${name} (${j.w}x${j.h}, ip=${j.ip} op=${j.op} fr=${j.fr})`);
    console.log(`  layers: ${fmt(counts.layer)}`);
    console.log(`  items:  ${fmt(counts.item)}  (fl=fill st=stroke gf=gradFill gs=gradStroke sh=path rc=rect el=ellipse tr=transform)`);
    console.log(`  mattes: ${counts.matte}  (track mattes: a layer matted by the one above it)`);
    console.log(`  masks:  ${counts.maskLayers} layers, ${counts.maskPaths} paths  modes: ${fmt(counts.maskModes) || "—"}  (a=add s=subtract i=intersect)`);
}
