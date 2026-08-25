import { describe, expect, it } from "vitest";

import { stripNoopPreloadWrappers } from "../../../scripts/bundle-scenes-core";

describe("bundle preload stripping", () => {
    it("strips bare and projected dynamic-import wrappers", () => {
        expect(stripNoopPreloadWrappers('p(()=>import("./a.js"),[])')).toBe('import("./a.js")');
        expect(stripNoopPreloadWrappers('p(()=>import("./a.js").then(m=>m.x),[])')).toBe('import("./a.js").then(m=>m.x)');
    });

    it("collapses async one-export projections to the module import", () => {
        expect(stripNoopPreloadWrappers('await p(async()=>{const{load:l}=await import("./a.js");return{load:l}},[])')).toBe('await import("./a.js")');
    });

    it("preserves unrelated empty arrays", () => {
        expect(stripNoopPreloadWrappers("map.set(key,[])")).toBe("map.set(key,[])");
    });
});
