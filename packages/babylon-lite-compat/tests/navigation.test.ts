import { describe, expect, it, vi } from "vitest";

import { WaitForFullTileCacheUpdate } from "../src/navigation/navigation";

/**
 * GPU/wasm-free coverage for the tile-cache obstacle surface. The plugin's
 * obstacle methods delegate straight to Lite's Recast API (which needs the wasm
 * runtime), but the standalone `WaitForFullTileCacheUpdate` dispatch is pure and
 * unit-testable: it must drive the plugin's obstacle update and stay a safe no-op
 * for any non-plugin argument.
 */
describe("WaitForFullTileCacheUpdate", () => {
    it("delegates to the plugin's tile-cache obstacle update", () => {
        const update = vi.fn();
        WaitForFullTileCacheUpdate({ _updateObstacles: update }, {});
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("is a safe no-op for a missing or foreign navMesh handle", () => {
        expect(() => WaitForFullTileCacheUpdate(undefined)).not.toThrow();
        expect(() => WaitForFullTileCacheUpdate({})).not.toThrow();
        expect(() => WaitForFullTileCacheUpdate(null)).not.toThrow();
    });
});
