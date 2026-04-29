import { unaryEmitter } from "./_math-factory.js";
export const emitter = unaryEmitter("NormalizeBlock", (v) => `normalize(${v})`);
