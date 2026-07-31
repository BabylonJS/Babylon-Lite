import type { EngineContext } from "../engine/engine.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { ensureSharedAtlasGpu } from "./_gpu/text-textures.js";
import { TEXT_INSTANCE_BYTES } from "./text-data.js";
import type { TextRenderer } from "./text-renderer.js";

const TEXT_UBO_BYTES = 96;

/**
 * Rebuild every registered TextRenderer on the replacement device.
 * This module is reached only through the Text recovery adapter's lazy import.
 */
export function rebuildRegisteredTextRenderers(engine: EngineContext): void {
    for (const surface of engine.surfaces) {
        for (const context of surface._renderingContexts) {
            if (context._kind !== "text-renderer") {
                continue;
            }
            rebuildTextRendererGpu(context as TextRenderer);
        }
    }
}

function rebuildTextRendererGpu(renderer: TextRenderer): void {
    const engine = renderer._surface.engine;
    const device = engine._device;
    renderer._visibleBundles.length = 0;

    for (const lg of renderer._layerGpu.values()) {
        lg.textU = createEmptyUniformBuffer(engine, TEXT_UBO_BYTES, "text-layer-ubo");
        lg.instanceBuf = device.createBuffer({
            label: "text-layer-instances",
            size: lg.instanceCap * TEXT_INSTANCE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        lg.pipeline = null;
        lg.bindGroups.length = 0;
        lg.bindGroupAtlasVersions.length = 0;
        lg.uploadedDataVersion = -1;
        lg.uploadedViewportW = 0;
        lg.uploadedViewportH = 0;
        lg.lastMvpInputs.fill(0);
        lg.mvpUploaded = false;
        lg.renderBundle = null;
        lg.bundleLayoutVersion = -1;
        lg.bundleDrawCalls = 0;
    }

    for (const layer of renderer.layers) {
        for (const group of layer.data._groups) {
            ensureSharedAtlasGpu(device, group.curveSet.atlas);
        }
    }
    renderer._update();
}
