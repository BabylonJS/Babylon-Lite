import type { EngineContext, EngineContextInternal } from "../../engine/engine.js";
import type { AssetContainer } from "../../asset-container.js";
import type { SceneContext } from "../../scene/scene.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { addTaskAtStart } from "../../frame-graph/frame-graph-actions.js";
import { createRenderTask } from "../../frame-graph/render-task.js";
import type { Pass } from "../../frame-graph/pass.js";
import type { Task } from "../../frame-graph/task.js";
import { createMipRenderTargetTexture } from "../../texture/rtt-mip.js";
import { recordMipmaps } from "../../texture/record-mipmaps.js";
import { _registerPbrExt } from "./pbr-flags.js";
import { refractionRttExt, setOpaqueSceneRefractionTexture, useOpaqueSceneRefraction } from "./fragments/refraction-rtt-fragment.js";

export function enablePbrOpaqueRefraction(scene: SceneContext, engine: EngineContext): void {
    setOpaqueSceneRefractionTexture(setupPbrRefraction(scene, engine as EngineContextInternal));
    _registerPbrExt(refractionRttExt);
}

export function usePbrOpaqueRefraction(container: AssetContainer): void {
    useOpaqueSceneRefraction(container);
}

function setupPbrRefraction(scene: SceneContext, engine: EngineContextInternal): Texture2D {
    const rtt = createMipRenderTargetTexture(engine, {
        label: "opaqueSceneTexture",
        colorFormat: "rgba16float",
        depthStencilFormat: "depth24plus-stencil8",
        mipLevelCount: 11,
        size: { width: 1024, height: 1024 },
    });
    const sc = scene as SceneContextInternal;
    const pass = createRenderTask(
        {
            name: "opaqueSceneTexture",
            rt: rtt.rt,
            clrColor: sc.clearColor,
            cs: true,
        },
        engine,
        scene
    );
    const execute = pass.execute!;
    pass.execute = () => {
        const imageProcessing = sc.imageProcessing as { toneMappingEnabled: boolean | number };
        const toneMappingEnabled = imageProcessing.toneMappingEnabled;
        imageProcessing.toneMappingEnabled = -1;
        try {
            return execute();
        } finally {
            imageProcessing.toneMappingEnabled = toneMappingEnabled;
        }
    };
    const mips: Task = {
        name: "opaqueSceneTexture-mips",
        engine,
        scene: sc,
        _passes: [],
        record(): void {
            const mipPass: Pass = {
                name: `${mips.name}-pass`,
                _parentTask: mips,
                _dependencies: new Set([rtt.rt]),
                _executeFunc: null,
                _beforeExecute: null,
                _initialize(): void {
                    return;
                },
                _execute(): number {
                    recordMipmaps(engine, rtt.texture.texture, engine._currentEncoder);
                    return 0;
                },
                _dispose(): void {
                    return;
                },
            };
            mips._passes.push(mipPass);
        },
        dispose(): void {
            this._passes.length = 0;
        },
    };
    addTaskAtStart(scene, mips);
    addTaskAtStart(scene, pass);
    sc._deferredBuilders.push(() => {
        sc._deferredBuilders.push(() => {
            pass._renderables.length = 0;
            pass._renderables.push(...sc._renderables.filter((r) => !r.isTransmissive));
            sc._frameGraph.build();
        });
    });
    return rtt.texture;
}
