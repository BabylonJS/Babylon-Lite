import { describe, expect, it, beforeAll } from "vitest";

import { getNoColorView, preloadPcfShadowTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { isMaterialView } from "../../../packages/babylon-lite/src/material/material-view";

/** Minimal device-free ShaderMaterial-shaped stub: getNoColorView only reads `_buildGroup._materialFamily`,
 *  `_shadowCasterMaterial`, and (for the shader family) hands the object to createShaderNoColorMaterialView,
 *  which is a pure createMaterialView wrap. */
function fakeShaderMaterial(name: string, shadowCaster?: Material): Material {
    return {
        name,
        _buildGroup: { _materialFamily: "shader" } as unknown as Material["_buildGroup"],
        _uboVersion: 0,
        ...(shadowCaster ? { _shadowCasterMaterial: shadowCaster } : {}),
    } as Material;
}

describe("shadow caster material override (Material._shadowCasterMaterial)", () => {
    // getNoColorView dispatches the shader family through a lazily-imported factory; preload it (the real CSM/PCF
    // task creation awaits this same step before calling getNoColorView).
    beforeAll(async () => {
        await preloadPcfShadowTaskState([{ material: fakeShaderMaterial("preload") } as unknown as Mesh]);
    });

    it("returns a no-colour view over the SOURCE material when there is no override", () => {
        const cache = new Map<Material, MaterialView>();
        const mat = fakeShaderMaterial("receive");
        const view = getNoColorView(mat, cache);
        expect(isMaterialView(view)).toBe(true);
        expect(view.source).toBe(mat);
    });

    it("returns the OVERRIDE material's no-colour view when _shadowCasterMaterial is set", () => {
        const cache = new Map<Material, MaterialView>();
        const caster = fakeShaderMaterial("caster");
        const receive = fakeShaderMaterial("receive", caster);
        const view = getNoColorView(receive, cache);
        // The view casts through the OVERRIDE material, not the receive material that would alias the depth map.
        expect(isMaterialView(view)).toBe(true);
        expect(view.source).toBe(caster);
        expect(view.source).not.toBe(receive);
    });

    it("caches the override view under the RECEIVE material so the caster-pass lookup hits", () => {
        const cache = new Map<Material, MaterialView>();
        const caster = fakeShaderMaterial("caster");
        const receive = fakeShaderMaterial("receive", caster);
        const first = getNoColorView(receive, cache);
        // Cached under the receive material (the key the CSM/PCF caster loop looks up by).
        expect(cache.get(receive)).toBe(first);
        // A second call returns the identical cached instance (no new view allocated).
        expect(getNoColorView(receive, cache)).toBe(first);
    });

    it("shares one view instance for the override material whether looked up by receive or by the override itself", () => {
        const cache = new Map<Material, MaterialView>();
        const caster = fakeShaderMaterial("caster");
        const receive = fakeShaderMaterial("receive", caster);
        const viaReceive = getNoColorView(receive, cache);
        const viaCaster = getNoColorView(caster, cache);
        expect(viaReceive).toBe(viaCaster);
    });
});
