/** ReflectionTextureBaseBlock compatibility registration.
 *
 * In Babylon.js this is a shared base class for concrete reflection blocks. It
 * has no usable standalone outputs in serialized editor graphs. Lite registers
 * it so snippets containing an unconnected compatibility/base block deserialize
 * cleanly, but surfaces a loud error if a graph attempts to emit it directly.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ReflectionTextureBaseBlock",
    emit(block): never {
        throw new Error(`ReflectionTextureBaseBlock "${block.name}" is an abstract compatibility block and cannot be emitted directly.`);
    },
};
