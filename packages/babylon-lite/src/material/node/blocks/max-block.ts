import { binaryEmitter } from "./_math-factory.js";
export const emitter = binaryEmitter("MaxBlock", (l, r) => `max(${l}, ${r})`);
