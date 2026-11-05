import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material.js";
import { pbrParallaxOcclusionExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/parallax-occlusion-fragment.js";
import { pbrExt as pbrUvTransform } from "../../../packages/babylon-lite/src/material/pbr/fragments/uv-transform-fragment.js";
import { stdParallaxOcclusionExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-parallax-occlusion-fragment.js";
import { stdUvTransformExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-uv-transform-fragment.js";
import { enableStandardUvOffset } from "../../../packages/babylon-lite/src/material/standard/enable-standard-mesh-features.js";
import { writeStandardUvTransformData } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline.js";
import { makeParallaxPbrFixture, makeParallaxStandardFixture, makeParallaxTexture } from "./parallax-occlusion-fixtures.js";

const UV = [0.23, 0.37] as const;

function transform(data: Float32Array, matrix: number, translation: number): readonly [number, number] {
    return [data[matrix]! * UV[0] + data[matrix + 1]! * UV[1] + data[translation]!, data[matrix + 2]! * UV[0] + data[matrix + 3]! * UV[1] + data[translation + 1]!];
}

function captureUniformWrite(bind: (scene: SceneContext) => void): Float32Array {
    const writeBuffer = vi.fn();
    const scene = {
        surface: { engine: { _device: { createBuffer: () => ({ destroy: vi.fn() }), queue: { writeBuffer } } } },
    } as unknown as SceneContext;
    bind(scene);
    expect(writeBuffer).toHaveBeenCalledOnce();
    const [, , buffer, offset, length] = writeBuffer.mock.calls[0] as [GPUBuffer, number, ArrayBuffer, number, number];
    return new Float32Array(buffer, offset, length / 4).slice();
}

function standardHeightData(material: StandardMaterialProps): Float32Array {
    return captureUniformWrite((scene) => {
        stdParallaxOcclusionExt._bind!(material, [], 0, undefined, scene, []);
    });
}

function expectSameUV(height: readonly number[], surface: readonly number[]): void {
    expect(height[0]).toBeCloseTo(surface[0]!, 6);
    expect(height[1]).toBeCloseTo(surface[1]!, 6);
}

describe("POM height UVs follow the actual material-family surface convention", () => {
    it.each([false, true])("matches codec-flipped PBR normal-map sampling (per-texture transforms: %s)", (transforms) => {
        const texture = makeParallaxTexture();
        texture.invertY = true;
        if (transforms) {
            Object.assign(texture, { uScale: 0.7, vScale: 1.5, uOffset: 0.2, vOffset: 0.3, uAng: 0.6 });
        }
        const fixture = makeParallaxPbrFixture({ texture, normal: "cotangent", transforms, settings: { heightChannel: "a" } });
        const spec = fixture.shader._materialUboSpec!;
        const data = new Float32Array(spec._totalBytes / 4);
        pbrUvTransform.writeUbo!(data, fixture.material, spec._offsets);
        pbrParallaxOcclusionExt.writeUbo!(data, fixture.material, spec._offsets);
        const surface = transforms ? transform(data, spec._offsets.get("normalUVm")! / 4, spec._offsets.get("normalUVt")! / 4) : UV;
        const height = transform(data, spec._offsets.get("parallaxUVm")! / 4, spec._offsets.get("parallaxUVt")! / 4);
        expectSameUV(height, surface);
        expect(fixture.shader._fragmentWGSL).toContain(`parallaxSample(normalTexture,normalSampler_,${transforms ? "normalUV" : "input.uv"},parallaxScreenOffset)`);
    });

    it("matches the transformed Standard surface, including its unconditional material offset and final codec flip", async () => {
        const texture = makeParallaxTexture();
        Object.assign(texture, { invertY: true, uScale: 0.7, vScale: 1.5, uOffset: 0.2, vOffset: 0.3, uAng: 0.6 });
        const fixture = await makeParallaxStandardFixture({ texture, transforms: true, settings: { heightChannel: "a" } });
        fixture.material.uvScale = [1.7, 1.5];
        fixture.material.uvOffset = [0.2, 0.25];
        const surface = captureUniformWrite((scene) => {
            stdUvTransformExt._bind!(fixture.material, [], 0, undefined, scene, []);
        });
        expectSameUV(transform(standardHeightData(fixture.material), 8, 12), transform(surface, 0, 4));
    });

    it("matches default Standard's pre-scale codec flip and reads material offsets only after the public enabler", async () => {
        const texture = makeParallaxTexture();
        texture.invertY = true;
        const fixture = await makeParallaxStandardFixture({ texture, settings: { heightChannel: "a" } });
        fixture.material.uvScale = [1.7, 1.5];
        fixture.material.uvOffset = [0.2, 0.25];
        for (const enabled of [false, true]) {
            if (enabled) {
                enableStandardUvOffset();
            }
            const surface = new Float32Array(4);
            writeStandardUvTransformData(surface, fixture.material, true);
            expect(surface[2]).toBeCloseTo(enabled ? 0.2 : 0);
            expect(surface[3]).toBeCloseTo(1.5 + (enabled ? 0.25 : 0));
            const expected = [UV[0] * surface[0]! + surface[2]!, UV[1] * surface[1]! + surface[3]!];
            expectSameUV(transform(standardHeightData(fixture.material), 8, 12), expected);
        }
    });
});
