import type { UsdContext } from "./usd-context.js";
import { UsdOp } from "./usd-protocol.js";
import { mat4Determinant3 } from "../math/mat4-determinant3.js";
import { _registerAssetContainerSceneCleanup } from "../loader-gltf/gltf-scene-cleanup.js";

/** @internal Optional command families are resolved only for assets that contain them. */
export async function applyUsdFeatures(context: UsdContext): Promise<void> {
    const has = (op: number) => context.records.some((record) => record.op === op);
    const features = [
        [has(UsdOp.Analytic), () => import("./usd-analytics.js")],
        [has(UsdOp.Skeleton), () => import("./usd-skeletons.js")],
        [has(UsdOp.MorphTarget), () => import("./usd-morphs.js")],
        [has(UsdOp.Instance), () => import("./usd-instances.js")],
        [has(UsdOp.ThinInstances), () => import("./usd-thin-instances.js")],
        [has(UsdOp.Animation), () => import("./usd-animation.js")],
    ] as const;
    for (const [needed, load] of features) {
        if (needed) {
            const feature = await load();
            context.signal?.throwIfAborted();
            await Promise.resolve(feature.apply(context));
        }
    }
    const mirrored = has(UsdOp.Animation) || context.container._usdMeshes.some((mesh) => mat4Determinant3(mesh.worldMatrix) > 0);
    const installMirroredMeshSupport = mirrored ? (await import("../material/standard/std-mirrored-support.js")).installMirroredMeshSupport : undefined;
    const publish = context.publishAnimation;
    if (installMirroredMeshSupport || publish) {
        context.container._sceneSetup = (scene, container) => {
            installMirroredMeshSupport?.(scene);
            if (publish) {
                scene._beforeRender.push(publish);
                _registerAssetContainerSceneCleanup(container, scene, () => {
                    const index = scene._beforeRender.indexOf(publish);
                    if (index >= 0) {
                        scene._beforeRender.splice(index, 1);
                    }
                });
            }
        };
    }
}
