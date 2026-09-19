import type { Page } from "@playwright/test";
import path from "node:path";
import type * as BabylonLite from "../../../../packages/babylon-lite/src/index.js";
import type { PlayroomState } from "../../../../lab/lite/src/demos/playroom/types.js";

const liteModuleUrl = `/@fs/${path.resolve("packages/babylon-lite/src/index.ts").replaceAll("\\", "/")}`;

declare global {
    interface Window {
        __playroomTemporalState?: PlayroomState;
    }
}

export interface TemporalTarget {
    readonly bodyName: string;
    readonly index: number;
    readonly screen?: readonly [number, number];
}

export interface TemporalPose {
    readonly nativeMatrix: number[];
    readonly cpuMatrix: number[];
    readonly gpuMatrix: number[];
    readonly velocity: number[];
    readonly bufferId: number;
    readonly thinVersion: number;
    readonly gpuVersion: number;
    readonly finishCount: number;
    readonly bundles: {
        readonly main: { readonly id: number; readonly executionCount: number };
        readonly shadow: { readonly id: number; readonly executionCount: number };
    };
}

export interface RagdollBindLandmark {
    readonly name: string;
    readonly boneIndex: number;
    readonly bindMatrix: readonly number[];
    readonly nearestConfigured: string;
}

export interface RagdollSkinSnapshot {
    readonly rootVertex: { readonly index: number; readonly rootWeight: number; readonly position: readonly number[] };
    readonly bones: Readonly<
        Record<
            string,
            {
                readonly position: readonly number[];
                readonly axes: readonly [readonly number[], readonly number[], readonly number[]];
            }
        >
    >;
    readonly bodies: Readonly<
        Record<
            string,
            {
                readonly position: readonly number[];
                readonly rotation: readonly number[];
                readonly jointPosition: readonly number[];
            }
        >
    >;
    readonly cameraTarget: readonly number[];
    readonly gpu: {
        readonly paletteCpuMaxDelta: number;
        readonly textureMatchesAsset: boolean;
        readonly textureId: number;
        readonly jointsBufferId: number;
        readonly weightsBufferId: number;
        readonly finishCount: number;
        readonly main: { readonly id: number; readonly executionCount: number };
    };
}

export async function installTemporalPlayroomRoute(page: Page): Promise<void> {
    await page.route("**/lite/demo-playroom.html", async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace("./bundle/demos/playroom.js", "./src/demos/playroom.ts");
        await route.fulfill({ response, body });
    });
    await page.route("**/lite/src/demos/playroom.ts*", async (route) => {
        const response = await route.fetch();
        const source = (await response.text()).replaceAll("import.meta.url", 'new URL("./bundle/demos/playroom.js", location.href).href');
        const marker = "game.cleanup.push(startupUi.dispose);";
        if (!source.includes(marker)) {
            throw new Error("Unable to expose the temporal Playroom test state.");
        }
        await route.fulfill({
            response,
            body: source.replace(marker, `globalThis.__playroomTemporalState = game;\n${marker}`),
        });
    });
}

export async function waitForTemporalPlayroom(page: Page, labTestPort: number): Promise<void> {
    await page.goto(`http://127.0.0.1:${labTestPort}/lite/demo-playroom.html`);
    await page.waitForFunction(
        () => {
            const canvas = document.getElementById("renderCanvas");
            return canvas?.dataset.ready === "true" || Boolean(canvas?.dataset.error);
        },
        undefined,
        { timeout: 60_000 }
    );
}

export async function prepareFreeModeTarget(page: Page, bodyName: string, index: number): Promise<TemporalTarget> {
    return page.evaluate(
        async ({ selectedBodyName, selectedIndex, moduleUrl }) => {
            const state = window.__playroomTemporalState!;
            const lite = (await import(moduleUrl)) as typeof BabylonLite;
            const record = state.world.records.find((candidate) => candidate.body.node.name === selectedBodyName)!;
            const matrices = (record.mesh as BabylonLite.Mesh).thinInstances!.matrices;
            const offset = selectedIndex * 16;
            const point = { x: matrices[offset + 12]!, y: matrices[offset + 13]!, z: matrices[offset + 14]! };
            const canvas = state.canvas;
            const rect = canvas.getBoundingClientRect();
            const cameraOffsets = [
                [0, 0.45, -2],
                [0, 0.45, 2],
                [-2, 0.45, 0],
                [2, 0.45, 0],
            ] as const;
            for (const cameraOffset of cameraOffsets) {
                state.freeCamera.position.set(point.x + cameraOffset[0], point.y + cameraOffset[1], point.z + cameraOffset[2]);
                state.freeCamera.target.x = point.x;
                state.freeCamera.target.y = point.y;
                state.freeCamera.target.z = point.z;
                await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const view = lite.getViewMatrix(state.freeCamera);
                const viewProjection = lite.getViewProjectionMatrix(state.freeCamera, canvas.width / canvas.height);
                const projected = lite.projectWorldToScreen(point, view, viewProjection, {
                    viewport: { x: 0, y: 0, width: canvas.width, height: canvas.height },
                    backingWidth: canvas.width,
                    backingHeight: canvas.height,
                    cssWidth: rect.width,
                    cssHeight: rect.height,
                });
                if (projected.offscreen) {
                    continue;
                }
                for (const dx of [0, -6, 6, -12, 12, -18, 18]) {
                    for (const dy of [0, -6, 6, -12, 12, -18, 18]) {
                        const ray = lite.createPickingRay(projected.cssX + dx, projected.cssY + dy, viewProjection, rect.width, rect.height);
                        if (!ray) {
                            continue;
                        }
                        const hit = lite.physicsRaycast(
                            state.physics,
                            { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] },
                            {
                                x: ray.origin[0] + ray.direction[0] * 1000,
                                y: ray.origin[1] + ray.direction[1] * 1000,
                                z: ray.origin[2] + ray.direction[2] * 1000,
                            }
                        );
                        if (hit.body === record.body && hit.bodyIndex === selectedIndex) {
                            return {
                                bodyName: selectedBodyName,
                                index: selectedIndex,
                                screen: [projected.cssX + dx + rect.left, projected.cssY + dy + rect.top] as const,
                            };
                        }
                    }
                }
            }
            throw new Error(`Unable to aim at ${selectedBodyName}[${selectedIndex}].`);
        },
        { selectedBodyName: bodyName, selectedIndex: index, moduleUrl: liteModuleUrl }
    );
}

export async function aimKickAtTarget(page: Page, bodyName: string, index: number): Promise<TemporalTarget> {
    return page.evaluate(
        ({ selectedBodyName, selectedIndex }) => {
            const state = window.__playroomTemporalState!;
            const record = state.world.records.find((candidate) => candidate.body.node.name === selectedBodyName)!;
            const matrices = (record.mesh as BabylonLite.Mesh).thinInstances!.matrices;
            const offset = selectedIndex * 16;
            const target = [matrices[offset + 12]!, matrices[offset + 13]!, matrices[offset + 14]!] as const;
            const root = state.ragdoll.root.mesh.position;
            const dx = target[0] - root.x;
            const dy = target[1] - root.y;
            const dz = target[2] - root.z;
            const length = Math.hypot(dx, dy, dz);
            const direction = [dx / length, dy / length, dz / length] as const;
            state.camera.alpha = Math.atan2(-direction[2], -direction[0]);
            state.camera.beta = Math.asin(direction[1]) + Math.PI * 0.25;
            return { bodyName: selectedBodyName, index: selectedIndex };
        },
        { selectedBodyName: bodyName, selectedIndex: index }
    );
}

export async function readTemporalPose(page: Page, target: TemporalTarget): Promise<TemporalPose> {
    return page.evaluate(
        async ({ selected, moduleUrl }) => {
            const state = window.__playroomTemporalState!;
            const lite = (await import(moduleUrl)) as typeof BabylonLite;
            const record = state.world.records.find((candidate) => candidate.body.node.name === selected.bodyName)!;
            const thin = (record.mesh as BabylonLite.Mesh).thinInstances!;
            const nativeHandle = state.physics._thin!.instance(record.body, selected.index)!;
            const native = state.physics._hknp.HP_Body_GetQTransform(nativeHandle)[1] as [number[], number[]];
            const velocity = { x: 0, y: 0, z: 0 };
            lite.getPhysicsBodyInstanceLinearVelocityToRef(state.physics, record.body, selected.index, velocity);
            const matrixOffset = selected.index * 16;
            const bufferId = window.__playroomObservedBufferId!(thin._gpuBuffer!);
            const observation = window.__playroomRenderBundleObservation!();
            const selectBoundBundle = (shadow: boolean) => {
                const candidates = observation.executedBundles.filter(
                    (bundle) =>
                        (bundle.descriptor.colorFormats.length === 0) === shadow && bundle.draws.some((draw) => draw.vertexBuffers.some((binding) => binding.bufferId === bufferId))
                );
                const bundle = candidates.sort((left, right) => right.bundleId - left.bundleId)[0];
                if (!bundle) {
                    throw new Error(`No executed ${shadow ? "shadow" : "main"} bundle binds thin-instance buffer ${bufferId}.`);
                }
                const executionCount = observation.executeBundlesMemberships
                    .filter((membership) => membership.bundleIds.includes(bundle.bundleId))
                    .reduce((sum, membership) => sum + membership.callCount, 0);
                return { id: bundle.bundleId, executionCount };
            };
            return {
                nativeMatrix: [...new Array<number>(12).fill(0), native[0][0]!, native[0][1]!, native[0][2]!, 1],
                cpuMatrix: Array.from(thin.matrices.slice(matrixOffset, matrixOffset + 16) as Float32Array),
                gpuMatrix: await window.__playroomReadObservedBufferFloats!(bufferId, matrixOffset * Float32Array.BYTES_PER_ELEMENT, 16),
                velocity: [velocity.x, velocity.y, velocity.z],
                bufferId,
                thinVersion: thin._version,
                gpuVersion: thin._gpuVersion,
                finishCount: observation.finishCount,
                bundles: {
                    main: selectBoundBundle(false),
                    shadow: selectBoundBundle(true),
                },
            };
        },
        { selected: target, moduleUrl: liteModuleUrl }
    );
}

export async function readRagdollSkinSnapshot(page: Page, landmarks: readonly RagdollBindLandmark[]): Promise<RagdollSkinSnapshot> {
    return page.evaluate(
        async ({ sourceLandmarks, moduleUrl }) => {
            const state = window.__playroomTemporalState!;
            const lite = (await import(moduleUrl)) as typeof BabylonLite;
            const findSkinnedMesh = (node: BabylonLite.SceneNode): BabylonLite.Mesh | null => {
                if ("skeleton" in node && node.skeleton) {
                    return node as BabylonLite.Mesh;
                }
                for (const child of node.children) {
                    const match = findSkinnedMesh(child);
                    if (match) {
                        return match;
                    }
                }
                return null;
            };
            const mesh = findSkinnedMesh(state.ragdoll.visualRoot);
            if (!mesh?.skeleton) {
                throw new Error("Unable to find the visible skinned bunny mesh.");
            }
            const skeleton = mesh.skeleton;
            const textureId = window.__playroomObservedTextureId!(skeleton.boneTexture);
            const jointsBufferId = window.__playroomObservedBufferId!(skeleton.jointsBuffer);
            const weightsBufferId = window.__playroomObservedBufferId!(skeleton.weightsBuffer);
            const cpuPalette = Array.from(skeleton.boneMatrices);
            const nativeTransforms = state.ragdoll.records.map((record) => {
                const native = state.physics._hknp.HP_Body_GetQTransform(record.body._hkBody)[1] as [number[], number[]];
                return [Array.from(native[0]), Array.from(native[1])] as const;
            });
            const cameraTarget = [state.camera.target.x, state.camera.target.y, state.camera.target.z];
            const gpuPalette = await window.__playroomReadObservedTextureFloats!(textureId, skeleton.boneMatrices.length);
            const paletteCpuMaxDelta = gpuPalette.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - cpuPalette[index]!)), 0);
            const meshWorld = Array.from(mesh.worldMatrix);

            const multiplyMatrices = (left: readonly number[], right: readonly number[]): number[] => {
                const result = new Array<number>(16);
                for (let column = 0; column < 4; column++) {
                    for (let row = 0; row < 4; row++) {
                        result[column * 4 + row] =
                            left[row]! * right[column * 4]! +
                            left[4 + row]! * right[column * 4 + 1]! +
                            left[8 + row]! * right[column * 4 + 2]! +
                            left[12 + row]! * right[column * 4 + 3]!;
                    }
                }
                return result;
            };
            const multiplyPoint = (matrix: readonly number[], x: number, y: number, z: number, w = 1): number[] => [
                matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]! * w,
                matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]! * w,
                matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]! * w,
            ];
            const normalize = (value: readonly number[]): number[] => {
                const inverseLength = 1 / Math.hypot(value[0]!, value[1]!, value[2]!);
                return [value[0]! * inverseLength, value[1]! * inverseLength, value[2]! * inverseLength];
            };
            const quaternionMultiply = (a: readonly number[], b: readonly number[]): number[] => [
                a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
                a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
                a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
                a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
            ];
            const quaternionInverse = (rotation: readonly number[]): number[] => {
                const inverseLengthSquared = 1 / rotation.reduce((sum, value) => sum + value * value, 0);
                return [-rotation[0]! * inverseLengthSquared, -rotation[1]! * inverseLengthSquared, -rotation[2]! * inverseLengthSquared, rotation[3]! * inverseLengthSquared];
            };
            const rotate = (rotation: readonly number[], value: readonly number[]): number[] => {
                const transformed = quaternionMultiply(quaternionMultiply(rotation, [value[0]!, value[1]!, value[2]!, 0]), quaternionInverse(rotation));
                return transformed.slice(0, 3);
            };
            const bindRotation = (matrix: readonly number[]): number[] => {
                const m00 = matrix[0]!;
                const m01 = matrix[4]!;
                const m02 = matrix[8]!;
                const m10 = matrix[1]!;
                const m11 = matrix[5]!;
                const m12 = matrix[9]!;
                const m20 = matrix[2]!;
                const m21 = matrix[6]!;
                const m22 = matrix[10]!;
                const trace = m00 + m11 + m22;
                let rotation: number[];
                if (trace > 0) {
                    const s = Math.sqrt(trace + 1) * 2;
                    rotation = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s * 0.25];
                } else if (m00 > m11 && m00 > m22) {
                    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
                    rotation = [s * 0.25, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
                } else if (m11 > m22) {
                    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
                    rotation = [(m01 + m10) / s, s * 0.25, (m12 + m21) / s, (m02 - m20) / s];
                } else {
                    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
                    rotation = [(m02 + m20) / s, (m12 + m21) / s, s * 0.25, (m10 - m01) / s];
                }
                const inverseLength = 1 / Math.hypot(...rotation);
                return rotation.map((value) => value * inverseLength);
            };

            const bones: Record<string, { position: number[]; axes: [number[], number[], number[]] }> = {};
            for (const landmark of sourceLandmarks) {
                const palette = gpuPalette.slice(landmark.boneIndex * 16, landmark.boneIndex * 16 + 16);
                const jointWorld = multiplyMatrices(multiplyMatrices(meshWorld, palette), landmark.bindMatrix);
                bones[landmark.name] = {
                    position: jointWorld.slice(12, 15),
                    axes: [normalize(jointWorld.slice(0, 3)), normalize(jointWorld.slice(4, 7)), normalize(jointWorld.slice(8, 11))],
                };
            }

            const bodies: Record<string, { position: number[]; rotation: number[]; jointPosition: number[] }> = {};
            for (let index = 0; index < state.assets.rig.joints.length; index++) {
                const joint = state.assets.rig.joints[index]!;
                const native = nativeTransforms[index]!;
                const position = Array.from(native[0]);
                const rotation = Array.from(native[1]);
                const bindOffset = rotate(bindRotation(joint.bindWorldMatrix), [joint.axis[0] * joint.boxOffset, joint.axis[1] * joint.boxOffset, joint.axis[2] * joint.boxOffset]);
                const currentOffset = rotate(rotation, bindOffset);
                bodies[joint.name] = {
                    position,
                    rotation,
                    jointPosition: [position[0]! - currentOffset[0]!, position[1]! - currentOffset[1]!, position[2]! - currentOffset[2]!],
                };
            }

            const geometry = lite.getMeshGeometry(mesh);
            if (!geometry) {
                throw new Error("The bunny mesh does not retain its POSITION stream.");
            }
            const rootBoneIndex = state.assets.bunnySkeleton.bones.findIndex((bone) => bone.name === state.assets.rig.root);
            let rootVertexIndex = -1;
            let rootWeight = -1;
            for (let vertex = 0; vertex < skeleton.weights.length / 4; vertex++) {
                let weight = 0;
                for (let slot = 0; slot < 4; slot++) {
                    if (skeleton.joints[vertex * 4 + slot] === rootBoneIndex) {
                        weight += skeleton.weights[vertex * 4 + slot]!;
                    }
                }
                if (weight > rootWeight) {
                    rootWeight = weight;
                    rootVertexIndex = vertex;
                }
            }
            const sourceOffset = rootVertexIndex * 3;
            let skinnedX = 0;
            let skinnedY = 0;
            let skinnedZ = 0;
            let skinnedW = 0;
            for (let slot = 0; slot < 4; slot++) {
                const weight = skeleton.weights[rootVertexIndex * 4 + slot]!;
                const boneIndex = skeleton.joints[rootVertexIndex * 4 + slot]!;
                const transformed = multiplyPoint(
                    gpuPalette.slice(boneIndex * 16, boneIndex * 16 + 16),
                    geometry.positions[sourceOffset]!,
                    geometry.positions[sourceOffset + 1]!,
                    geometry.positions[sourceOffset + 2]!
                );
                skinnedX += transformed[0]! * weight;
                skinnedY += transformed[1]! * weight;
                skinnedZ += transformed[2]! * weight;
                skinnedW += weight;
            }
            const rootVertexPosition = multiplyPoint(meshWorld, skinnedX, skinnedY, skinnedZ, skinnedW);

            const observation = window.__playroomRenderBundleObservation!();
            const selectBoundBundle = () => {
                const candidates = observation.executedBundles.filter(
                    (bundle) =>
                        bundle.descriptor.colorFormats.length > 0 &&
                        bundle.draws.some((draw) => {
                            const buffers = draw.vertexBuffers.map((binding) => binding.bufferId);
                            return buffers.includes(jointsBufferId) && buffers.includes(weightsBufferId) && draw.textureIds.includes(textureId);
                        })
                );
                const bundle = candidates.sort((left, right) => right.bundleId - left.bundleId)[0];
                if (bundle) {
                    return {
                        id: bundle.bundleId,
                        executionCount: observation.executeBundlesMemberships
                            .filter((membership) => membership.bundleIds.includes(bundle.bundleId))
                            .reduce((sum, membership) => sum + membership.callCount, 0),
                    };
                }
                throw new Error("No executed main bundle binds the bunny skin resources.");
            };

            return {
                rootVertex: { index: rootVertexIndex, rootWeight, position: rootVertexPosition },
                bones,
                bodies,
                cameraTarget,
                gpu: {
                    paletteCpuMaxDelta,
                    textureMatchesAsset: state.assets.bunnyMesh.skeleton?.boneTexture === skeleton.boneTexture,
                    textureId,
                    jointsBufferId,
                    weightsBufferId,
                    finishCount: observation.finishCount,
                    main: selectBoundBundle(),
                },
            };
        },
        { sourceLandmarks: landmarks, moduleUrl: liteModuleUrl }
    );
}

export async function waitForTargetMovement(page: Page, target: TemporalTarget, initialPosition: readonly number[], threshold: number, timeout = 5_000): Promise<void> {
    await page.waitForFunction(
        ({ selected, initial, minimum }) => {
            const state = window.__playroomTemporalState!;
            const record = state.world.records.find((candidate) => candidate.body.node.name === selected.bodyName)!;
            const nativeHandle = state.physics._thin!.instance(record.body, selected.index)!;
            const position = state.physics._hknp.HP_Body_GetQTransform(nativeHandle)[1][0] as number[];
            return Math.hypot(position[0]! - initial[0]!, position[1]! - initial[1]!, position[2]! - initial[2]!) > minimum;
        },
        { selected: target, initial: initialPosition, minimum: threshold },
        { timeout }
    );
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export function matrixPosition(matrix: readonly number[]): number[] {
    return matrix.slice(12, 15);
}
