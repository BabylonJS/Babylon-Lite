// GetProperty (BJS FlowGraphGetPropertyBlock + JsonPointerParser, glTF op
// `pointer/get`). Data block (PULL): emits `value` read through a pre-resolved
// accessor.
//
// LITE DIVERGENCE: BJS resolves the JSON pointer at runtime via a separate
// JsonPointerParser block (object + propertyName + getter/setter). Lite's loader
// pre-resolves the pointer to an `FgAccessor` (get/set closures) at load time
// and stores it in `env.accessors`, keyed by `config.accessor`. So a single
// block reads via the accessor — the parser/path-converter owns pointer
// resolution. See flow-graph/gltf/path-converter.ts.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { pointerTypesCompatible, resolveBlockAccessor } from "../../pointer-template.js";
import { defaultForType } from "../../rich-type.js";
import { getEditorProperty } from "./editor-property.js";

export const getPropertyDef: FgBlockDef = {
    type: FgBlockType.GetProperty,
    build: (config) => ({
        dataIn:
            config?.editorPropertyAccess === true
                ? [sockIn("object", FgType.Any), sockIn("propertyName", FgType.String)]
                : ((config?.pointerSegments as string[] | undefined) ?? []).map((name) => sockIn(name, FgType.Any)),
        dataOut: [sockOut("value", (config?.type as FgType | undefined) ?? FgType.Any), sockOut("isValid", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        if (block.config?.editorPropertyAccess === true) {
            const result = getEditorProperty(getDataValue(ctx, env, block, "object"), getDataValue(ctx, env, block, "propertyName"));
            setDataValue(ctx, block, "value", result.value);
            setDataValue(ctx, block, "isValid", result.valid);
            return;
        }
        const accessor = resolveBlockAccessor(block, ctx, env);
        const valid = !!accessor && pointerTypesCompatible(block.config?.type as FgType | undefined, accessor.type);
        const type = (block.config?.type as FgType | undefined) ?? FgType.Any;
        const value = valid ? accessor.get() : defaultForType(type);
        setDataValue(ctx, block, "value", value);
        setDataValue(ctx, block, "isValid", valid);
    },
};
