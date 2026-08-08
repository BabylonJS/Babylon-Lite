import { beforeEach, describe, expect, it, vi } from "vitest";

import { PBR2_HAS_UV_TRANSFORM } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";

describe("PBR UV transform detection", () => {
    // `_registerPbrExt` writes to a module-level registry, so each test needs a fresh
    // module graph — otherwise an earlier opt-in leaks the ext into the next test.
    beforeEach(() => {
        vi.resetModules();
    });

    it("opts a hand-built material into UV transforms before build", async () => {
        const { enableMaterialUvTransform } = await import("../../../packages/babylon-lite/src/material/pbr/enable-material-uv-transform");
        const material = {} as PbrMaterialProps;
        expect(enableMaterialUvTransform(material)).toBe(true);
        expect(material._hasUvTx).toBe(true);

        (material as PbrMaterialProps & { _renderFeatures: { features: number } })._renderFeatures = { features: 0 };
        expect(enableMaterialUvTransform(material)).toBe(false);
    });

    // Regression guard for the opt-in's real contract: `_computePbrMaterialFeatures` carries no
    // uv-transform check of its own, so the bit exists only because the opt-in registers the lazy
    // ext whose `detect` reads `_hasUvTx`. Setting the flag without going through the opt-in — or
    // moving the opt-in somewhere that skips `_registerPbrExt` — is a silent no-op.
    it("contributes PBR2_HAS_UV_TRANSFORM only once the opt-in registers the ext", async () => {
        const { _computePbrMaterialFeatures } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        const bare = { _hasUvTx: true } as PbrMaterialProps;
        expect(_computePbrMaterialFeatures(bare).features2 & PBR2_HAS_UV_TRANSFORM).toBe(0);

        const { enableMaterialUvTransform } = await import("../../../packages/babylon-lite/src/material/pbr/enable-material-uv-transform");
        const optedIn = {} as PbrMaterialProps;
        enableMaterialUvTransform(optedIn);
        expect(_computePbrMaterialFeatures(optedIn).features2 & PBR2_HAS_UV_TRANSFORM).toBe(PBR2_HAS_UV_TRANSFORM);
    });
});
