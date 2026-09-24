import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { invertMat4 } from "../../../../packages/babylon-lite/src/math/invert-mat4.js";
import type { Mat4 } from "../../../../packages/babylon-lite/src/math/types.js";
import {
    aimKickAtTarget,
    installTemporalPlayroomRoute,
    matrixPosition,
    readRagdollSkinSnapshot,
    readTemporalPose,
    waitForTargetMovement,
    waitForTemporalPlayroom,
} from "./runtime-physics-gpu.js";
import type { RagdollBindLandmark, RagdollSkinSnapshot } from "./runtime-physics-gpu.js";
import { installWebGpuRenderBundleObserver } from "./webgpu-render-bundle-observer.js";

interface Snapshot {
    sourceRevision: string;
    counts: { bodies: number; constraints: number };
    initial: {
        frames: number;
        groundContactCount: number;
        allDynamicBeforePlay: boolean;
        rootStartY: number;
        rootSettledY: number;
        maxLinearSpeed: number;
        maxAngularSpeed: number;
        allBodiesTranslationSettled: boolean;
        skeletonMatchesPhysics: boolean;
    };
    launches: {
        forceCount: number;
        forceMagnitudes: number[];
        allDynamicBeforeForce: boolean[];
        doubleKickGuarded: boolean;
        currentPoseRetained: boolean[];
        noTeleportOnKick: boolean[];
        forceAppliedAtCurrentRoot: boolean[];
        nextStartedDynamic: boolean[];
        nextSettledOnGround: boolean[];
        nextMaxLinearSpeeds: number[];
        nextMaxAngularSpeeds: number[];
        replayStartedDynamic: boolean;
        replaySettledOnGround: boolean;
        replayMaxLinearSpeed: number;
        replayMaxAngularSpeed: number;
        scoreReset: boolean;
        skeletonMatchesPhysics: boolean[];
    };
    stableIdentities: { bodies: boolean; constraints: boolean };
}

const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);

function loadRagdollBindLandmarks(): RagdollBindLandmark[] {
    const bytes = readFileSync(resolve(process.cwd(), "lab", "public", "playroom", "gltf", "bunny_rigged.glb"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
        nodes: Array<{ name?: string; children?: number[] }>;
        skins: Array<{ joints: number[]; inverseBindMatrices: number }>;
        accessors: Array<{ bufferView: number; byteOffset?: number }>;
        bufferViews: Array<{ byteOffset?: number }>;
    };
    const binaryChunkOffset = 20 + jsonLength + 8;
    const skin = json.skins[0]!;
    const accessor = json.accessors[skin.inverseBindMatrices]!;
    const byteOffset = binaryChunkOffset + (json.bufferViews[accessor.bufferView]!.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const inverseBind = new Float32Array(bytes.buffer, bytes.byteOffset + byteOffset, skin.joints.length * 16);
    const configured = new Set(
        (JSON.parse(readFileSync(resolve(process.cwd(), "lab", "public", "playroom", "gltf", "bunny-rig.json"), "utf8")) as { joints: Array<{ name: string }> }).joints.map(
            (joint) => joint.name
        )
    );
    const parents = new Map<number, number>();
    json.nodes.forEach((node, parent) => node.children?.forEach((child) => parents.set(child, parent)));
    return skin.joints.map((nodeIndex, boneIndex) => {
        const name = json.nodes[nodeIndex]!.name ?? `bone_${boneIndex}`;
        let ancestor = nodeIndex;
        while (!configured.has(json.nodes[ancestor]!.name ?? "")) {
            const parent = parents.get(ancestor);
            if (parent === undefined) {
                throw new Error(`Bone ${name} has no configured ragdoll ancestor.`);
            }
            ancestor = parent;
        }
        const bindMatrix = invertMat4(inverseBind.slice(boneIndex * 16, boneIndex * 16 + 16) as unknown as Mat4);
        if (!bindMatrix) {
            throw new Error(`Bone ${name} has a singular inverse-bind matrix.`);
        }
        return { name, boneIndex, bindMatrix: Array.from(bindMatrix), nearestConfigured: json.nodes[ancestor]!.name! };
    });
}

const ragdollBindLandmarks = loadRagdollBindLandmarks();
const ragdollRig = JSON.parse(readFileSync(resolve(process.cwd(), "lab", "public", "playroom", "gltf", "bunny-rig.json"), "utf8")) as {
    root: string;
    joints: Array<{ name: string; nearestConfiguredParent: string | null }>;
};

function quaternionMultiply(left: readonly number[], right: readonly number[]): number[] {
    return [
        left[3]! * right[0]! + left[0]! * right[3]! + left[1]! * right[2]! - left[2]! * right[1]!,
        left[3]! * right[1]! - left[0]! * right[2]! + left[1]! * right[3]! + left[2]! * right[0]!,
        left[3]! * right[2]! + left[0]! * right[1]! - left[1]! * right[0]! + left[2]! * right[3]!,
        left[3]! * right[3]! - left[0]! * right[0]! - left[1]! * right[1]! - left[2]! * right[2]!,
    ];
}

function inverseQuaternion(rotation: readonly number[]): number[] {
    const inverseLengthSquared = 1 / rotation.reduce((sum, value) => sum + value * value, 0);
    return [-rotation[0]! * inverseLengthSquared, -rotation[1]! * inverseLengthSquared, -rotation[2]! * inverseLengthSquared, rotation[3]! * inverseLengthSquared];
}

function rotate(rotation: readonly number[], value: readonly number[]): number[] {
    return quaternionMultiply(quaternionMultiply(rotation, [value[0]!, value[1]!, value[2]!, 0]), inverseQuaternion(rotation)).slice(0, 3);
}

function subtract(left: readonly number[], right: readonly number[]): number[] {
    return [left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!];
}

function add(left: readonly number[], right: readonly number[]): number[] {
    return [left[0]! + right[0]!, left[1]! + right[1]!, left[2]! + right[2]!];
}

function distance(left: readonly number[], right: readonly number[]): number {
    return Math.hypot(...subtract(left, right));
}

function expectFinalSkinAligned(before: RagdollSkinSnapshot, current: RagdollSkinSnapshot): void {
    expect(current.rootVertex.index).toBe(before.rootVertex.index);
    expect(current.rootVertex.rootWeight).toBeGreaterThan(0.999999);
    expect(current.gpu.paletteCpuMaxDelta).toBe(0);
    expect(current.gpu.textureMatchesAsset).toBe(true);
    expect(current.gpu.textureId).toBe(before.gpu.textureId);
    expect(current.gpu.jointsBufferId).toBe(before.gpu.jointsBufferId);
    expect(current.gpu.weightsBufferId).toBe(before.gpu.weightsBufferId);

    const expectedPositions = new Map<string, readonly number[]>();
    const unresolved = new Set(ragdollRig.joints.map((joint) => joint.name));
    while (unresolved.size > 0) {
        let resolved = false;
        for (const joint of ragdollRig.joints) {
            if (!unresolved.has(joint.name) || (joint.nearestConfiguredParent !== null && !expectedPositions.has(joint.nearestConfiguredParent))) {
                continue;
            }
            if (joint.nearestConfiguredParent === null) {
                expectedPositions.set(joint.name, current.bodies[joint.name]!.jointPosition);
            } else {
                const parentName = joint.nearestConfiguredParent;
                const parentDelta = quaternionMultiply(current.bodies[parentName]!.rotation, inverseQuaternion(before.bodies[parentName]!.rotation));
                expectedPositions.set(
                    joint.name,
                    add(expectedPositions.get(parentName)!, rotate(parentDelta, subtract(before.bones[joint.name]!.position, before.bones[parentName]!.position)))
                );
            }
            unresolved.delete(joint.name);
            resolved = true;
        }
        expect(resolved, "ragdoll configured-joint hierarchy").toBe(true);
    }

    for (const configuredName of Object.keys(current.bodies)) {
        expect(distance(current.bones[configuredName]!.position, expectedPositions.get(configuredName)!), `${configuredName} source hierarchy`).toBeLessThan(0.001);
        const delta = quaternionMultiply(current.bodies[configuredName]!.rotation, inverseQuaternion(before.bodies[configuredName]!.rotation));
        for (let axis = 0; axis < 3; axis++) {
            expect(distance(current.bones[configuredName]!.axes[axis]!, rotate(delta, before.bones[configuredName]!.axes[axis]!)), `${configuredName} axis ${axis}`).toBeLessThan(
                0.002
            );
        }
    }

    for (const landmark of ragdollBindLandmarks) {
        if (current.bodies[landmark.name]) {
            continue;
        }
        const configuredName = landmark.nearestConfigured;
        const beforeBody = before.bodies[configuredName]!;
        const currentBody = current.bodies[configuredName]!;
        const delta = quaternionMultiply(currentBody.rotation, inverseQuaternion(beforeBody.rotation));
        const expectedPosition = add(
            current.bones[configuredName]!.position,
            rotate(delta, subtract(before.bones[landmark.name]!.position, before.bones[configuredName]!.position))
        );
        expect(distance(current.bones[landmark.name]!.position, expectedPosition), `${landmark.name} inherited position`).toBeLessThan(0.002);
        for (let axis = 0; axis < 3; axis++) {
            expect(
                distance(current.bones[landmark.name]!.axes[axis]!, rotate(delta, before.bones[landmark.name]!.axes[axis]!)),
                `${landmark.name} inherited axis ${axis}`
            ).toBeLessThan(0.002);
        }
    }

    const rootBeforeBody = before.bodies.root!;
    const rootCurrentBody = current.bodies.root!;
    const rootDelta = quaternionMultiply(rootCurrentBody.rotation, inverseQuaternion(rootBeforeBody.rotation));
    const expectedRootVertex = add(rootCurrentBody.position, rotate(rootDelta, subtract(before.rootVertex.position, rootBeforeBody.position)));
    expect(distance(current.rootVertex.position, expectedRootVertex), "root-weighted visible vertex").toBeLessThan(0.002);
}

test("settles the dynamic bunny before every current-pose launch and reuses it through replay", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${labTestPort}/lite/playroom-ragdoll-harness.html`);
    await page.waitForFunction(
        () => {
            const canvas = document.getElementById("renderCanvas");
            return canvas?.dataset.ready === "true" || Boolean(canvas?.dataset.error);
        },
        undefined,
        { timeout: 60_000 }
    );
    const error = await page.locator("#renderCanvas").getAttribute("data-error");
    expect(error).toBeNull();
    const data = JSON.parse((await page.locator("#playroom-ragdoll-snapshot").textContent())!) as Snapshot;

    expect(data.sourceRevision).toBe("d22ce23ef308e28d1f8b6598b4c72ea944205925");
    expect(data.counts).toEqual({ bodies: 10, constraints: 9 });
    expect(data.initial.frames).toBe(300);
    expect(data.initial.groundContactCount).toBeGreaterThan(0);
    expect(data.initial.allDynamicBeforePlay).toBe(true);
    expect(data.initial.rootSettledY).toBeLessThan(data.initial.rootStartY - 0.2);
    expect(data.initial.allBodiesTranslationSettled).toBe(true);
    expect(data.initial.maxLinearSpeed).toBeLessThan(0.15);
    expect(data.initial.skeletonMatchesPhysics).toBe(true);
    expect(data.launches.forceCount).toBe(3);
    expect(data.launches.forceMagnitudes).toHaveLength(3);
    for (const force of data.launches.forceMagnitudes) {
        expect(force).toBeCloseTo(500, 4);
    }
    expect(data.launches.allDynamicBeforeForce).toEqual([true, true, true]);
    expect(data.launches.doubleKickGuarded).toBe(true);
    expect(data.launches.currentPoseRetained).toEqual([true, true, true]);
    expect(data.launches.noTeleportOnKick).toEqual([true, true, true]);
    expect(data.launches.forceAppliedAtCurrentRoot).toEqual([true, true, true]);
    expect(data.launches.nextStartedDynamic).toEqual([true, true]);
    expect(data.launches.nextSettledOnGround).toEqual([true, true]);
    expect(data.launches.replayStartedDynamic).toBe(true);
    expect(data.launches.replaySettledOnGround).toBe(true);
    expect(data.launches.scoreReset).toBe(true);
    expect(data.launches.skeletonMatchesPhysics).toEqual([true, true, true, true]);
    expect(data.stableIdentities).toEqual({ bodies: true, constraints: true });
});

test("keeps an impacted node-material block synchronized in cached main and shadow bundles", async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(installWebGpuRenderBundleObserver);
    await installTemporalPlayroomRoute(page);
    await waitForTemporalPlayroom(page, labTestPort);
    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForTimeout(4_000);
    const target = await aimKickAtTarget(page, "tower-19", 11);
    const before = await readTemporalPose(page, target);

    await page.getByRole("button", { name: "Kick" }).click();
    await page.evaluate(() => {
        window.__playroomTemporalState!.poppersArmed = false;
    });
    await waitForTargetMovement(page, target, matrixPosition(before.nativeMatrix), 0.01);
    const after = await readTemporalPose(page, target);

    const nativePosition = matrixPosition(after.nativeMatrix);
    const cpuPosition = matrixPosition(after.cpuMatrix);
    const gpuPosition = matrixPosition(after.gpuMatrix);
    for (let axis = 0; axis < 3; axis++) {
        expect(nativePosition[axis]).toBeCloseTo(cpuPosition[axis]!, 3);
        expect(gpuPosition[axis]).toBeCloseTo(cpuPosition[axis]!, 3);
    }
    expect(Math.hypot(...after.velocity)).toBeGreaterThan(0.01);
    expect(after.thinVersion).toBe(after.gpuVersion);
    expect(after.bufferId).toBe(before.bufferId);
    expect(after.bundles.main.id).toBe(before.bundles.main.id);
    expect(after.bundles.shadow.id).toBe(before.bundles.shadow.id);
    expect(after.bundles.main.executionCount).toBeGreaterThan(before.bundles.main.executionCount);
    expect(after.bundles.shadow.executionCount).toBeGreaterThan(before.bundles.shadow.executionCount);
    expect(after.finishCount).toBe(before.finishCount);
});

for (const launch of [
    { name: "negative X", alpha: 0, expectedAxis: 0, expectedSign: -1 },
    { name: "positive X", alpha: Math.PI, expectedAxis: 0, expectedSign: 1 },
    { name: "negative Z control", alpha: Math.PI / 2, expectedAxis: 2, expectedSign: -1 },
] as const) {
    test(`keeps the GPU-skinned bunny aligned with Havok through a ${launch.name} launch`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.addInitScript(installWebGpuRenderBundleObserver);
        await installTemporalPlayroomRoute(page);
        await waitForTemporalPlayroom(page, labTestPort);
        await page.getByRole("button", { name: "Play" }).click();
        await page.waitForTimeout(1_000);
        await page.evaluate(({ alpha }) => {
            const state = window.__playroomTemporalState!;
            state.camera.alpha = alpha;
            state.camera.beta = Math.PI * 0.25;
        }, launch);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

        const before = await readRagdollSkinSnapshot(page, ragdollBindLandmarks);
        expectFinalSkinAligned(before, before);
        await page.getByRole("button", { name: "Kick" }).click();

        let prior = before;
        let elapsed = 0;
        for (const targetElapsed of [150, 450, 900, 1_500]) {
            await page.waitForTimeout(targetElapsed - elapsed);
            const current = await readRagdollSkinSnapshot(page, ragdollBindLandmarks);
            expectFinalSkinAligned(before, current);
            expect(current.gpu.main.executionCount).toBeGreaterThan(0);
            prior = current;
            elapsed = targetElapsed;
        }

        const displacement = prior.bodies.root!.position[launch.expectedAxis]! - before.bodies.root!.position[launch.expectedAxis]!;
        expect(displacement * launch.expectedSign).toBeGreaterThan(1);
        expect(distance(prior.cameraTarget, prior.bodies.root!.position)).toBeLessThan(0.25);
    });
}
