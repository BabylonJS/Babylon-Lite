import { describe, expect, it } from "vitest";
import { createParticleBillboard } from "../../../packages/babylon-lite/src/particle/particle-billboard";
import { addFacingBillboardSystemWithParticleBlend } from "../../../packages/babylon-lite/src/particle/particle-billboard-scene";
import { createParticleBlend } from "../../../packages/babylon-lite/src/particle/particle-blend";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { buildNodeParticleSetWithBlendModes, enableNodeParticleBlendModes } from "../../../packages/babylon-lite/src/particle/node/npe-blend-modes";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { systemBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/system-block";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import type { NodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { FacingBillboardSpriteSystem } from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function createBillboardForMode(blendMode: number, exact = true): FacingBillboardSpriteSystem {
    const system = createParticleSystem(1);
    system.blendMode = blendMode;
    system.texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 1,
        height: 1,
    } satisfies Texture2D;
    const billboard = createParticleBillboard(system);
    if (exact) {
        addFacingBillboardSystemWithParticleBlend(createRegistrationScene(), billboard, blendMode);
    }
    return billboard;
}

function createRegistrationScene(): SceneContext {
    return { _disposables: [], _pickSources: [], _deferredBuilders: [] } as unknown as SceneContext;
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
        const billboard = createParticleBillboard(system);
        addFacingBillboardSystemWithParticleBlend(createRegistrationScene(), billboard, system.blendMode);

        expect(system.blendMode).toBe(4);
        expect(billboard.blendMode._key).toBe("p4");
    });

    it("maps Babylon.js modes 0 through 4 and falls back to Add", () => {
        expect([0, 1, 2, 3, 4, 99].map((mode) => createBillboardForMode(mode).blendMode._key)).toEqual(["p0", "p1", "p2", "p3", "p4", "p2"]);
    });

    it("keeps the base builder mapping and falls back unsupported modes to Add", () => {
        expect([0, 1, 2, 3, 4, 99].map((mode) => createBillboardForMode(mode, false).blendMode._key)).toEqual(["oneone", "alpha", "additive", "additive", "additive", "additive"]);
    });

    it("resolves a mutable blend mode when the enriched set is registered", async () => {
        const graph = parseNodeParticleSource({
            blocks: [{ customType: "BABYLON.SystemBlock", id: 1, name: "system", capacity: 1, blendMode: 3, inputs: [], outputs: [] }],
        });
        const set = await buildNodeParticleSetWithBlendModes({} as EngineContext, {} as SceneContext, graph);
        const system = set.systems[0]!;
        system.blendMode = 4;
        system.texture = {
            texture: {} as GPUTexture,
            view: {} as GPUTextureView,
            sampler: {} as GPUSampler,
            width: 1,
            height: 1,
        } satisfies Texture2D;
        const base = createParticleBillboard(system);
        system._registerBillboard!(createRegistrationScene(), base);

        expect(base.blendMode._key).toBe("p4");
        expect(base._customShader?._key).toBe("particle-multiply");
    });

    it("enables blend modes on a set produced by any specialized builder", () => {
        const set = { systems: [createParticleSystem(1)] } as NodeParticleSet;

        expect(enableNodeParticleBlendModes(set)).toBe(set);
        expect(set.systems[0]!._registerBillboard).toBeTypeOf("function");
    });

    it("matches Babylon.js color and alpha blend factors", () => {
        expect(createParticleBlend(0)._descriptor).toEqual({
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
        });
        expect(createParticleBlend(1)._descriptor).toEqual({
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        });
        expect(createParticleBlend(2)._descriptor).toEqual({
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
        });
        expect(createParticleBlend(3)._descriptor).toEqual({
            color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        });
    });

    it("defines MultiplyAdd as a Multiply shader pass followed by Add", () => {
        expect(createParticleBlend(4)._descriptor).toEqual(createParticleBlend(3)._descriptor);
    });
});
