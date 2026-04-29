import { binaryEmitter } from "./_math-factory.js";
export const emitter = binaryEmitter("AddBlock", (l, r) => `${l} + ${r}`);
