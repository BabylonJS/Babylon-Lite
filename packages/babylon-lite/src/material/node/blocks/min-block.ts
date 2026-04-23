import { binaryEmitter } from "./_math-factory.js";
export const emitter = binaryEmitter("MinBlock", (l, r) => `min(${l}, ${r})`);
