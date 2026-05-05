import { unaryEmitter } from "./_math-factory.js";

export const emitter = unaryEmitter("OppositeBlock", (v) => `1.0 - ${v}`);
