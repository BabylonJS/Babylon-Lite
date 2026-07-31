import { describe, expect, it } from "vitest";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import changeEmitRateGraph from "./fixtures/change-emit-rate-npe.json";
import changeEmitRateTruth from "./fixtures/change-emit-rate-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { parseNodeParticleSetFromSnippet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { animateParticleSystem, startParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

interface MutableGraphSource {
    blocks: Array<{
        customType: string;
        inputs: Array<{ name: string; targetBlockId?: number; targetConnectionName?: string | null }>;
    }>;
}

function systemEmitRateInput(source: MutableGraphSource): MutableGraphSource["blocks"][number]["inputs"][number] {
    const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    return system.inputs.find((input) => input.name === "emitRate")!;
}

describe("NPE build reachability", () => {
    it("builds typed-array systems through the canonical inline-JSON API", async () => {
        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "", {
            json: SCENE262_NPE_JSON,
            emitter: { x: 0, y: 0, z: 0 },
        });

        expect(set.systems).toHaveLength(1);
        expect(set.systems[0]!.buffer.posX).toBeInstanceOf(Float32Array);
    });

    it("uses the Babylon NPE update-speed default when it is not serialized", async () => {
        const source = structuredClone(SCENE262_NPE_JSON) as { blocks: Array<Record<string, unknown>> };
        const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
        delete system.updateSpeed;

        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source));

        expect(set.systems[0]!.updateSpeed).toBe(0.0167);
    });

    it("ignores detached unsupported and OncePerParticle blocks", async () => {
        const source = JSON.parse(JSON.stringify(SCENE262_NPE_JSON)) as { blocks: Array<Record<string, unknown>> };
        source.blocks.push(
            { customType: "BABYLON.UnsupportedDetachedBlock", id: 10001, name: "detached unsupported", inputs: [], outputs: [] },
            { customType: "BABYLON.ParticleRandomBlock", id: 10002, name: "detached once", lockMode: 3, inputs: [], outputs: [{ name: "output" }] }
        );

        const graph = parseNodeParticleSource(source);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        expect(set.systems).toHaveLength(1);
        expect([...set.systems[0]!.buffer._columns.keys()].some((name) => name.startsWith("random.10002."))).toBe(false);
    });

    it("treats a port without a target connection name as unconnected", async () => {
        const source = structuredClone(changeEmitRateGraph) as MutableGraphSource;
        systemEmitRateInput(source).targetConnectionName = null;

        const graph = parseNodeParticleSource(source);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;

        expect(system.emitRate).toBe(10);
        expect(system._emitRateGetter).toBeUndefined();
    });

    it("does not evaluate a connected emit-rate graph during build", async () => {
        const source = structuredClone(changeEmitRateGraph) as MutableGraphSource;
        const emitRate = systemEmitRateInput(source);
        emitRate.targetBlockId = 8;
        emitRate.targetConnectionName = "output";

        const previousRandom = Math.random;
        let randomCalls = 0;
        Math.random = () => {
            randomCalls++;
            return 0.5;
        };
        try {
            const graph = parseNodeParticleSource(source);
            const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
            expect(set.systems[0]!._emitRateGetter).toBeDefined();
        } finally {
            Math.random = previousRandom;
        }

        expect(randomCalls).toBe(0);
    });

    it("re-evaluates a connected emit-rate graph from system time", async () => {
        const truth = changeEmitRateTruth as { N: number; count: number };
        const graph = parseNodeParticleSource(changeEmitRateGraph);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system._emitRateGetter).toBeDefined();

        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };
        try {
            startParticleSystem(system);
            for (let step = 0; step < truth.N; step++) {
                animateParticleSystem(system, 1);
            }
        } finally {
            Math.random = previousRandom;
        }

        expect(system.buffer.alive).toBe(truth.count);
    });
});
