import { binaryEmitter } from "./_math-factory.js";
export const emitter = binaryEmitter("MultiplyBlock", (l, r) => `${l} * ${r}`);
