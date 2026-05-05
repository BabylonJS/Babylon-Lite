import { binaryEmitter } from "./_math-factory.js";

export const emitter = binaryEmitter("DivideBlock", (l, r) => `${l} / ${r}`);
