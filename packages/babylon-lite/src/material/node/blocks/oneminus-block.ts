import { unaryEmitter } from "./_math-factory.js";
export const emitter = unaryEmitter("OneMinusBlock", (v) => `1.0 - ${v}`);
