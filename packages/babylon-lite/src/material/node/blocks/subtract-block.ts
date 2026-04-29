import { binaryEmitter } from "./_math-factory.js";
export const emitter = binaryEmitter("SubtractBlock", (l, r) => `${l} - ${r}`);
