// Extract the two SMAA lookup textures (base64 PNG data URLs) from the vendored glsl-smaa package
// into a single standalone ES module, so the oracle page can import them without pulling in the
// package's own web of .js shader wrappers.
import { readFileSync, writeFileSync } from "fs";

const src = readFileSync("scripts/smaa-ref/package/index.js", "utf8");
const grab = (key: string): string => {
    const m = src.match(new RegExp(`${key}:\\s*"(data:image/png;base64,[^"]+)"`));
    if (!m) throw new Error(`could not find ${key} data url`);
    return m[1]!;
};
const area = grab("area");
const search = grab("search");
writeFileSync("lab/public/smaa-ref/textures.js", `export const SMAATextures = ${JSON.stringify({ area, search }, null, 1)};\n`);
console.log(`area ${area.length} chars, search ${search.length} chars -> lab/public/smaa-ref/textures.js`);
