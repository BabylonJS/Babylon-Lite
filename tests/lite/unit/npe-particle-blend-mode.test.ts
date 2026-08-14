import { describe, expect, it } from "vitest";
import { createParticleBillboard } from "../../../packages/babylon-lite/src/particle/particle-billboard";
import { createParticleBlend } from "../../../packages/babylon-lite/src/particle/particle-blend";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { buildNodeParticleSetWithBlendModes } from "../../../packages/babylon-lite/src/particle/node/npe-blend-modes";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { systemBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/system-block";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { FacingBillboardSpriteSystem } from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function createBillboardForMode(blendMode: number, exact = true): FacingBillboardSpriteSystem {
    const system = createParticleSystem(1);
    system.blendMode = blendMode;
    if (exact) {
        system._particleBlend = createParticleBlend(blendMode);
    }
    system.texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 1,
        height: 1,
    } satisfies Texture2D;
    return createParticleBillboard(system);
}

describe("NPE particle blend modes", () => {
    it("preserves a serialized SystemBlock mode through billboard creation", () => {
        const system = createParticleSystem(1);
        const block = { id: 1, className: "SystemBlock", name: "system", serialized: { blendMode: 4 }, inputs: [] } as ParsedParticleBlock;
        const ctx = {
            state: { system },
            input(_block: ParsedParticleBlock, _name: string, fallback?: () => unknown) {
                return fallback!;
            },
            isConnected() {
                return false;
            },
        } as unknown as NpeBuildContext;
        systemBlock.build(block, ctx);
        system.texture = {
            texture: {} as GPUTexture,
            view: {} as GPUTextureView,
            sampler: {} as GPUSampler,
            width: 1,
            height: 1,
        } satisfies Texture2D;
        system._particleBlend = createParticleBlend(system.blendMode);

        expect(system.blendMode).toBe(4);
        expect(createParticleBillboard(system).blendMode._key).toBe("p4");
    });

    it("maps Babylon.js modes 0 through 4 and falls back to Add", () => {
        expect([0, 1, 2, 3, 4, 99].map((mode) => createBillboardForMode(mode).blendMode._key)).toEqual(["p0", "p1", "p2", "p3", "p4", "p2"]);
    });

    it("keeps the base builder mapping and falls back unsupported modes to Add", () => {
        expect([0, 1, 2, 3, 4, 99].map((mode) => createBillboardForMode(mode, false).blendMode._key)).toEqual(["oneone", "alpha", "additive", "additive", "additive", "additive"]);
    });

    it("installs exact blend state and advanced registration through the explicit builder", async () => {
        const graph = parseNodeParticleSource({
            blocks: [{ customType: "BABYLON.SystemBlock", id: 1, name: "system", capacity: 1, blendMode: 4, inputs: [], outputs: [] }],
        });
        const set = await buildNodeParticleSetWithBlendModes({} as EngineContext, {} as SceneContext, graph);

        expect(set.systems[0]!._particleBlend?._key).toBe("p4");
        expect(set.systems[0]!._addBillboardSystem).toBeTypeOf("function");
    });

    it("matches Babylon.js color and alpha blend factors", () => {
        expect(createBillboardForMode(0).blendMode._descriptor).toEqual({
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
        });
        expect(createBillboardForMode(1).blendMode._descriptor).toEqual({
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        });
        expect(createBillboardForMode(2).blendMode._descriptor).toEqual({
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
        });
        expect(createBillboardForMode(3).blendMode._descriptor).toEqual({
            color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        });
    });

    it("defines MultiplyAdd as a Multiply shader pass followed by Add", () => {
        expect(createBillboardForMode(4).blendMode._descriptor).toEqual(createBillboardForMode(3).blendMode._descriptor);
    });
});
