import { describe, expect, it } from "vitest";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import changeEmitRateGraph from "./fixtures/change-emit-rate-npe.json";
import changeEmitRateTruth from "./fixtures/change-emit-rate-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { parseNodeParticleSetFromSnippet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { buildSoaParticleSet } from "../../../packages/babylon-lite/src/particle/soa/npe-build";
import { animateSoa, startSoaSystem } from "../../../packages/babylon-lite/src/particle/soa/animate";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

describe("SoA NPE build reachability", () => {
    it("builds typed-array systems through the canonical inline-JSON API", async () => {
        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "", {
            json: SCENE262_NPE_JSON,
            emitter: { x: 0, y: 0, z: 0 },
        });

        expect(set.systems).toHaveLength(1);
        expect(set.systems[0]!.buffer.posX).toBeInstanceOf(Float32Array);
    });

    it("ignores detached unsupported and OncePerParticle blocks", async () => {
        const source = JSON.parse(JSON.stringify(SCENE262_NPE_JSON)) as { blocks: Array<Record<string, unknown>> };
        source.blocks.push(
            { customType: "BABYLON.UnsupportedDetachedBlock", id: 10001, name: "detached unsupported", inputs: [], outputs: [] },
            { customType: "BABYLON.ParticleRandomBlock", id: 10002, name: "detached once", lockMode: 3, inputs: [], outputs: [{ name: "output" }] }
        );

        const graph = parseNodeParticleSource(source);
        const set = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        expect(set.systems).toHaveLength(1);
        expect(set.systems[0]!.buffer._columns.has("random.10002.value")).toBe(false);
    });

    it("re-evaluates a connected emit-rate graph from system time", async () => {
        const truth = changeEmitRateTruth as { N: number; count: number };
        const graph = parseNodeParticleSource(changeEmitRateGraph);
        const set = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system._emitRateGetter).toBeDefined();

        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };
        try {
            startSoaSystem(system);
            for (let step = 0; step < truth.N; step++) {
                animateSoa(system, 1);
            }
        } finally {
            Math.random = previousRandom;
        }

        expect(system.buffer.alive).toBe(truth.count);
    });
});
