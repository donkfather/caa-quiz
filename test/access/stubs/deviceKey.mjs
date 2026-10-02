// Key names must match src/lib/deviceKey.ts (asserted in dataReset.test.mjs).
export const DEVICE_KEY_MIRROR_KEY = "trial_device_key_v1";
export async function getDeviceKey() { return { key: "k".repeat(16), platform: "ios" }; }
export async function readReportDeviceId() {
  const id = globalThis.__store.get("device_id");
  return id ? id : null;
}
