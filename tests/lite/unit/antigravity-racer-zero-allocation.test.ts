import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const demoRoot = new URL("../../../lab/lite/src/demos/antigravity-racer/", import.meta.url);

function source(name: string): string {
    return readFileSync(fileURLToPath(new URL(name, demoRoot)), "utf8");
}

describe("antigravity racer steady-state allocation contract", () => {
    it("preallocates the controls callback instead of creating one every simulation step", () => {
        const game = source("game.ts");
        expect(game).not.toContain("grid.tick((slot)");
    });

    it("mutates the demo-camera translation scratch when it re-anchors", () => {
        const camera = source("camera-rig.ts");
        expect(camera).not.toMatch(/const aim = \{/);
        expect(camera).not.toMatch(/this\._translate = \{/);
    });

    it("reads gamepads only during poll and reuses right-stick output objects", () => {
        const input = source("input.ts");
        expect(input.match(/navigator\.getGamepads/g)).toHaveLength(1);
        expect(input).not.toContain("return { x: 0, y: 0 }");
        expect(input).not.toMatch(/return \{ x: Math\.max/);
    });

    it("does not allocate a new HUD speed string when the displayed value is unchanged", () => {
        const hud = source("hud.ts");
        expect(hud).not.toContain("pane.speed.textContent = String(Math.round");
        expect(hud).toContain("if (speed !== pane.value)");
    });
});
