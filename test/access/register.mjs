// Preloaded by `npm test` (node --import) for the access scenarios: swaps the
// react-native / expo / network modules that access.ts and dataReset.ts import
// for the in-memory stubs in ./stubs, so the real files run under plain Node.
import * as nodeModule from "node:module";
import { resolve } from "./loader.mjs";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve }); // in-thread, synchronous (Node >= 22.15)
} else {
  nodeModule.register("./loader.mjs", import.meta.url); // older Node
}
globalThis.__DEV__ = false;
