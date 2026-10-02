// Module-resolution hook (see register.mjs). Bare and relative specifiers in
// this map resolve to a stub whatever file imports them; every other
// extension-less relative import gets ".ts" appended, as Metro would resolve it.
// Synchronous, so it works with both module.registerHooks and module.register.
const STUBS = new URL("./stubs/", import.meta.url);

const map = {
  "react-native": "rn.mjs",
  "@react-native-async-storage/async-storage": "async.mjs",
  "expo-constants": "constants.mjs",
  "./supabase": "supabase.mjs",
  "./settings": "settings.mjs",
  "./purchases": "purchases.mjs",
  "./deviceKey": "deviceKey.mjs",
  "./buildFlags": "buildFlags.mjs",
};

export function resolve(spec, ctx, next) {
  if (map[spec]) return { url: new URL(map[spec], STUBS).href, shortCircuit: true };
  if (spec.startsWith("./") && !/\.[a-z]+$/.test(spec)) return next(`${spec}.ts`, ctx);
  return next(spec, ctx);
}
