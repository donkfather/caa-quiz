// In-memory AsyncStorage. globalThis.__readFail makes every read throw.
const store = (globalThis.__store = new Map());
const readGuard = () => {
  if (globalThis.__readFail) throw new Error("read fail");
};
export default {
  async getItem(k) { readGuard(); return store.has(k) ? store.get(k) : null; },
  async setItem(k, v) { store.set(k, String(v)); },
  async removeItem(k) { store.delete(k); },
  async getAllKeys() { readGuard(); return [...store.keys()]; },
  async multiRemove(keys) { for (const k of keys) store.delete(k); },
  async clear() { store.clear(); },
};
