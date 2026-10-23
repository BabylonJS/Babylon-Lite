/** KHR_materials_iridescence writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, hasTx, samplesUv1, setUnlessDefault } from "../export-material-slots.js";

export const iridescenceWriter: MaterialExtensionWriter = (ctx, material, out, uvState) => {
    const ir = material._iridescence;
    if (ir?.isEnabled !== true) {
        return;
    }
    const payload: GltfJsonObject = {};
    setUnlessDefault(payload, "iridescenceFactor", ir.intensity ?? 1, 0);
    capturePbrSlot(ctx, material, uvState, payload, {
        key: "iridescenceTexture",
        texture: ir.texture,
        transform: hasTx(ir.texture),
        uv1: samplesUv1(ir.texture),
    });
    setUnlessDefault(payload, "iridescenceIor", ir.indexOfRefraction ?? 1.3, 1.3);
    setUnlessDefault(payload, "iridescenceThicknessMinimum", ir.minimumThickness ?? 100, 100);
    setUnlessDefault(payload, "iridescenceThicknessMaximum", ir.maximumThickness ?? 400, 400);
    capturePbrSlot(ctx, material, uvState, payload, {
        key: "iridescenceThicknessTexture",
        texture: ir.thicknessTexture,
        transform: hasTx(ir.thicknessTexture),
        uv1: samplesUv1(ir.thicknessTexture),
    });
    attachExtension(ctx, out, "KHR_materials_iridescence", payload);
};
