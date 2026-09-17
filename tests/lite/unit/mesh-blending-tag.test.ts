import { describe, expect, it } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import {
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    resolveMeshBlendingTag,
    unpackMeshBlendingTag,
    validatePackedMeshBlendingTag,
} from "../../../packages/babylon-lite/src/mesh/mesh-blending-tag";
import {
    MeshBlendDebugMode,
    MeshBlendDepthType,
    MeshBlendQuality,
    createDefaultMeshBlendRadiusDefinitions,
    createMeshBlendRadiusDefinition,
    createMeshBlendingPostProcessTask,
} from "../../../packages/babylon-lite/src/post-process/mesh-blending";
import type { MeshBlendingPostProcessTaskConfig } from "../../../packages/babylon-lite/src/post-process/mesh-blending";
import {
    calculateMeshBlendEffectiveWorldRadius,
    calculateMeshBlendFade,
    calculateMeshBlendSearchRadius,
    calculateMeshBlendSlopeScale,
    getMeshBlendingQualitySettings,
    projectMeshBlendWorldRadiusToPixels,
} from "../../../packages/babylon-lite/src/post-process/mesh-blending-wgsl";

describe("mesh-blending tags", () => {
    it("packs and unpacks every valid nonzero group and radius class", () => {
        for (let groupId = 1; groupId <= 63; groupId++) {
            for (let radiusClass = MeshBlendingRadiusClass.Small; radiusClass <= MeshBlendingRadiusClass.ExtraLarge; radiusClass++) {
                const packed = packMeshBlendingTag(groupId, radiusClass);
                expect(packed).toBe((radiusClass << 6) | groupId);
                expect(validatePackedMeshBlendingTag(packed)).toBe(packed);
                expect(unpackMeshBlendingTag(packed)).toEqual({ groupId, radiusClass });
            }
        }
    });

    it("canonicalizes disabled group zero to the exact zero byte", () => {
        for (let radiusClass = MeshBlendingRadiusClass.Small; radiusClass <= MeshBlendingRadiusClass.ExtraLarge; radiusClass++) {
            expect(packMeshBlendingTag(0, radiusClass)).toBe(0);
        }
        expect(unpackMeshBlendingTag(0)).toEqual({ groupId: 0, radiusClass: MeshBlendingRadiusClass.Small });
    });

    it.each([-1, 64, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid group ID %s", (groupId) => {
        expect(() => packMeshBlendingTag(groupId, MeshBlendingRadiusClass.Small)).toThrow(RangeError);
    });

    it.each([-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid radius class %s", (radiusClass) => {
        expect(() => packMeshBlendingTag(1, radiusClass as MeshBlendingRadiusClass)).toThrow(RangeError);
    });

    it.each([-1, 1.5, 256, Number.NaN, Number.POSITIVE_INFINITY, 64, 128, 192])("rejects invalid raw packed tag %s", (tag) => {
        expect(() => validatePackedMeshBlendingTag(tag)).toThrow(RangeError);
        expect(() => unpackMeshBlendingTag(tag)).toThrow(RangeError);
    });

    it("uses the tag owned by each independent mesh", () => {
        const first = { meshBlendingTag: packMeshBlendingTag(7, MeshBlendingRadiusClass.Large) } as Mesh;
        const second = { meshBlendingTag: packMeshBlendingTag(9, MeshBlendingRadiusClass.Small) } as Mesh;

        expect(resolveMeshBlendingTag(first)).toBe(packMeshBlendingTag(7, MeshBlendingRadiusClass.Large));
        expect(resolveMeshBlendingTag(second)).toBe(packMeshBlendingTag(9, MeshBlendingRadiusClass.Small));
        expect(resolveMeshBlendingTag({} as Mesh)).toBe(0);
    });

    it("uses the draw-owning source tag for thin-instance semantics and validates it raw", () => {
        const thinInstanceSource = { meshBlendingTag: packMeshBlendingTag(31, MeshBlendingRadiusClass.ExtraLarge), thinInstances: { count: 2 } } as unknown as Mesh;
        expect(resolveMeshBlendingTag(thinInstanceSource)).toBe(223);

        thinInstanceSource.meshBlendingTag = 192;
        expect(() => resolveMeshBlendingTag(thinInstanceSource)).toThrow(/group ID/);
    });
});

function createTask(overrides: Partial<MeshBlendingPostProcessTaskConfig> = {}) {
    const sourceTexture = createRenderTarget({ format: "rgba16float", samples: 1, size: { width: 64, height: 32 } });
    const meshBlendTagTexture = createRenderTarget({ format: "r8uint", samples: 1, size: { width: 64, height: 32 } });
    const depthTexture = createRenderTarget({ format: "r32float", samples: 1, size: { width: 64, height: 32 } });
    return createMeshBlendingPostProcessTask(
        {
            sourceTexture,
            meshBlendTagTexture,
            depthTexture,
            camera: {} as Camera,
            ...overrides,
        },
        {} as EngineContext
    );
}

describe("mesh-blending configuration and radius math", () => {
    it("creates the exact defaults as a frozen tuple of independently mutable validated elements", () => {
        const definitions = createDefaultMeshBlendRadiusDefinitions();
        expect(definitions.map(({ worldRadius, minimumProjectedRadius }) => [worldRadius, minimumProjectedRadius])).toEqual([
            [0.06, 1.5],
            [0.1, 3],
            [0.2, 3],
            [0.3, 5],
        ]);
        expect(Object.isFrozen(definitions)).toBe(true);
        expect(new Set(definitions).size).toBe(4);

        definitions[0].worldRadius = 0.25;
        definitions[0].minimumProjectedRadius = 2;
        expect(definitions[0]).toMatchObject({ worldRadius: 0.25, minimumProjectedRadius: 2 });
        expect(definitions[1]).toMatchObject({ worldRadius: 0.1, minimumProjectedRadius: 3 });
        expect(() => {
            definitions[0].worldRadius = -1;
        }).toThrow(RangeError);
        expect(() => {
            definitions[0].minimumProjectedRadius = Number.NaN;
        }).toThrow(RangeError);
    });

    it("clones caller radius definitions and applies the documented task defaults", () => {
        const callerDefinitions = [
            createMeshBlendRadiusDefinition(1, 2),
            createMeshBlendRadiusDefinition(3, 4),
            createMeshBlendRadiusDefinition(5, 6),
            createMeshBlendRadiusDefinition(7, 8),
        ] as const;
        const sourceTexture = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 16, height: 8 } });
        const task = createMeshBlendingPostProcessTask(
            {
                sourceTexture,
                meshBlendTagTexture: createRenderTarget({ format: "r8uint", samples: 1, size: { width: 16, height: 8 } }),
                depthTexture: createRenderTarget({ format: "r32float", samples: 1, size: { width: 16, height: 8 } }),
                camera: {} as Camera,
                radiusClasses: callerDefinitions,
            },
            {} as EngineContext
        );

        expect(task.name).toBe("mesh-blending");
        expect(task.quality).toBe(MeshBlendQuality.Medium);
        expect(task.depthType).toBe(MeshBlendDepthType.View);
        expect(task.debugMode).toBe(MeshBlendDebugMode.Off);
        expect(task.slopeFactor).toBe(2);
        expect(task.enabled).toBe(true);
        expect(task.alphaMode).toBe(0);
        expect(task.viewport).toBeNull();
        expect(task.clear).toBe(true);
        expect(task.baseColorTexture).toBeNull();
        expect(task.targetTexture).toBeNull();
        expect(task.outputTexture).not.toBe(sourceTexture);
        expect(Object.isFrozen(task.radiusClasses)).toBe(true);
        expect(task.radiusClasses[0]).not.toBe(callerDefinitions[0]);

        callerDefinitions[0].worldRadius = 99;
        expect(task.radiusClasses[0].worldRadius).toBe(1);
        task.radiusClasses[0].worldRadius = 10;
        expect(callerDefinitions[0].worldRadius).toBe(99);
        task.dispose();
    });

    it("validates radius definitions, enum state, and slope factor at creation and mutation boundaries", () => {
        expect(() => createMeshBlendRadiusDefinition(-0.01, 0)).toThrow(RangeError);
        expect(() => createMeshBlendRadiusDefinition(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(() => createTask({ radiusClasses: [] })).toThrow(/exactly four/);
        expect(() => createTask({ quality: 4 as MeshBlendQuality })).toThrow(RangeError);
        expect(() => createTask({ depthType: 2 as MeshBlendDepthType })).toThrow(RangeError);
        expect(() => createTask({ debugMode: 13 as MeshBlendDebugMode })).toThrow(RangeError);
        expect(() => createTask({ slopeFactor: 0 })).toThrow(RangeError);

        const task = createTask();
        expect(() => {
            task.quality = 4 as MeshBlendQuality;
        }).toThrow(RangeError);
        expect(() => {
            task.depthType = 2 as MeshBlendDepthType;
        }).toThrow(RangeError);
        expect(() => {
            task.debugMode = 13 as MeshBlendDebugMode;
        }).toThrow(RangeError);
        expect(() => {
            task.slopeFactor = 0.999;
        }).toThrow(RangeError);
        expect(() => {
            task.slopeFactor = Number.NaN;
        }).toThrow(RangeError);
        task.slopeFactor = 1;
        expect(task.slopeFactor).toBe(1);
        task.dispose();
    });

    it("exposes the exact compile-time quality table", () => {
        expect([MeshBlendQuality.Low, MeshBlendQuality.Medium, MeshBlendQuality.High, MeshBlendQuality.Cinematic].map(getMeshBlendingQualitySettings)).toEqual([
            {
                directionCount: 3,
                radialSampleCount: 2,
                directionRefinementSampleCount: 1,
                directionRefinementStepCount: 2,
                exactEdgeSampleCount: 5,
                radiusScale: 0.5,
                fullRandomRotation: false,
                searchJitterFactor: 0.5,
                immediateFourNeighborFallback: false,
                tinyObjectSafeguard: false,
                multiTargetSecondaryBlend: false,
                colorInterpolation: "sRGB",
            },
            {
                directionCount: 3,
                radialSampleCount: 3,
                directionRefinementSampleCount: 2,
                directionRefinementStepCount: 4,
                exactEdgeSampleCount: 8,
                radiusScale: 0.9,
                fullRandomRotation: false,
                searchJitterFactor: 0.5,
                immediateFourNeighborFallback: false,
                tinyObjectSafeguard: false,
                multiTargetSecondaryBlend: false,
                colorInterpolation: "OKLab",
            },
            {
                directionCount: 3,
                radialSampleCount: 3,
                directionRefinementSampleCount: 3,
                directionRefinementStepCount: 5,
                exactEdgeSampleCount: 10,
                radiusScale: 1,
                fullRandomRotation: true,
                searchJitterFactor: 0.5,
                immediateFourNeighborFallback: true,
                tinyObjectSafeguard: true,
                multiTargetSecondaryBlend: true,
                colorInterpolation: "OKLab",
            },
            {
                directionCount: 8,
                radialSampleCount: 6,
                directionRefinementSampleCount: 4,
                directionRefinementStepCount: 5,
                exactEdgeSampleCount: 50,
                radiusScale: 0.95,
                fullRandomRotation: true,
                searchJitterFactor: 1,
                immediateFourNeighborFallback: true,
                tinyObjectSafeguard: true,
                multiTargetSecondaryBlend: true,
                colorInterpolation: "OKLab",
            },
        ]);
    });

    it("matches perspective, orthographic, minimum-radius, inverse-radius, fade, and slope equations", () => {
        expect(projectMeshBlendWorldRadiusToPixels(0.2, 10, 1000, 2, false)).toBeCloseTo(20);
        expect(projectMeshBlendWorldRadiusToPixels(0.2, 10, 1000, 2, true)).toBeCloseTo(200);
        expect(calculateMeshBlendSearchRadius({ worldRadius: 0, minimumProjectedRadius: 3 }, 10, 1000, 2, false, MeshBlendQuality.Low)).toBeCloseTo(1.5);
        expect(calculateMeshBlendSearchRadius({ worldRadius: 0, minimumProjectedRadius: 0 }, 10, 1000, 2, false, MeshBlendQuality.Cinematic)).toBe(0);
        expect(calculateMeshBlendEffectiveWorldRadius(20, 10, 1000, 2, false)).toBeCloseTo(0.2);
        expect(calculateMeshBlendEffectiveWorldRadius(200, 10, 1000, 2, true)).toBeCloseTo(0.2);

        expect(calculateMeshBlendFade(0.5, 4)).toBeCloseTo(0.5);
        expect(calculateMeshBlendFade(2.5, 4)).toBeCloseTo(0.125);
        expect(calculateMeshBlendFade(4.5, 4)).toBe(0);

        expect(calculateMeshBlendSlopeScale(-1, 2)).toBe(0.25);
        expect(calculateMeshBlendSlopeScale(0.5, 2)).toBeCloseTo(0.625);
        expect(calculateMeshBlendSlopeScale(1, 8)).toBe(1);
        expect(calculateMeshBlendSlopeScale(0, 1)).toBe(1);
    });
});
