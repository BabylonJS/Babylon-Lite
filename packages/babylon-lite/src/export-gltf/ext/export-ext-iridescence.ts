/** KHR_materials_iridescence writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, hasTx, setUnlessDefault } from "../export-material-slots.js";

export const iridescenceWriter: MaterialExtensionWriter = {
    name: "KHR_materials_iridescence",
    write(ctx, material, out, uvState) {
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
            uv1: (ir.texture as { _texCoord?: number } | undefined)?._texCoord === 1,
        });
        setUnlessDefault(payload, "iridescenceIor", ir.indexOfRefraction ?? 1.3, 1.3);
        setUnlessDefault(payload, "iridescenceThicknessMinimum", ir.minimumThickness ?? 100, 100);
        setUnlessDefault(payload, "iridescenceThicknessMaximum", ir.maximumThickness ?? 400, 400);
        capturePbrSlot(ctx, material, uvState, payload, {
            key: "iridescenceThicknessTexture",
            texture: ir.thicknessTexture,
            transform: hasTx(ir.thicknessTexture),
            uv1: (ir.thicknessTexture as { _texCoord?: number } | undefined)?._texCoord === 1,
        });
        attachExtension(ctx, out, "KHR_materials_iridescence", payload);
    },
};
