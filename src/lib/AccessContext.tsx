import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { DAY_MS, type AccessState } from "./accessCore";
import {
  getAccessSnapshot,
  markUnlocked,
  onAccessChanged,
  refreshAccess,
  startTrial as startAccessTrial,
  watchStorePurchases,
} from "./access";
import { purchaseUnlock, restorePurchases, type PurchaseResult } from "./purchases";
import { loadSettings } from "./settings";
import { cancelStreakReminder, scheduleStreakReminder } from "./notifications";

interface AccessContextValue {
  /** null until the first verdict is known — render nothing/splash meanwhile. */
  state: AccessState | null;
  refresh(): Promise<void>;
  startTrial(): Promise<void>;
  purchase(): Promise<PurchaseResult>;
  restore(): Promise<boolean | null>;
}

const AccessContext = createContext<AccessContextValue | null>(null);

/** Streak reminders only make sense while the app can be used. Once locked,
 * "Rezolvă un test azi" would lead straight to the lock screen, and the
 * switch that turns them off (Settings) is behind it — so they are cancelled.
 * The user's choice (settings.reminderEnabled) is kept, and the reminders come
 * back as soon as the app is usable again (without asking for permission). */
async function applyReminderPolicy(locked: boolean): Promise<void> {
  try {
    if (locked) {
      await cancelStreakReminder();
      return;
    }
    const s = await loadSettings();
    if (s.reminderEnabled) {
      await scheduleStreakReminder(s.reminderHour, s.reminderMinute, { askPermission: false });
    }
  } catch (e) {
    if (__DEV__) console.warn("streak reminder sync failed:", e);
  }
}

export function useAccess(): AccessContextValue {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess must be used inside <AccessProvider>");
  return ctx;
}

export function AccessProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AccessState | null>(() => getAccessSnapshot());

  useEffect(() => {
    const unsubscribe = onAccessChanged(setState);
    // A snapshot may have landed between the first render and this effect.
    const current = getAccessSnapshot();
    if (current) setState(current);
    void refreshAccess();
    // Re-check on every return to the foreground, so a trial that ended while
    // the app sat in the background (possibly for days) is noticed.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshAccess();
    });
    // A purchase that settles while the app is open (Ask to Buy, a pending
    // payment, a purchase on another device) unlocks without a relaunch.
    const unwatch = watchStorePurchases();
    return () => {
      unsubscribe();
      sub.remove();
      unwatch();
    };
  }, []);

  const kind = state?.kind ?? null;
  useEffect(() => {
    // "new" (the intro) leaves reminders alone: starting the trial is one tap.
    if (kind === "expired") void applyReminderPolicy(true);
    else if (kind === "trial" || kind === "unlocked") void applyReminderPolicy(false);
  }, [kind]);

  // While a trial runs with the app left open, re-check when the day count
  // ticks over — and, on the last day, at the exact moment it ends.
  const msLeft = state?.kind === "trial" ? state.msLeft : null;
  useEffect(() => {
    if (msLeft === null) return;
    const delay = (msLeft % DAY_MS || DAY_MS) + 1_000;
    const timer = setTimeout(() => {
      void refreshAccess();
    }, delay);
    return () => clearTimeout(timer);
  }, [msLeft]);

  const refresh = useCallback(async () => {
    await refreshAccess();
  }, []);

  const startTrial = useCallback(async () => {
    await startAccessTrial();
  }, []);

  const purchase = useCallback(async (): Promise<PurchaseResult> => {
    let res: PurchaseResult;
    try {
      res = await purchaseUnlock();
    } catch {
      res = { success: false, message: "Achiziția nu a putut fi finalizată." };
    }
    if (res.success) await markUnlocked();
    return res;
  }, []);

  const restore = useCallback(async (): Promise<boolean | null> => {
    let restored: boolean | null;
    try {
      restored = await restorePurchases();
    } catch {
      restored = null;
    }
    if (restored === true) await markUnlocked();
    // Re-resolve in the background; the state arrives through the subscription,
    // so the caller's spinner doesn't wait on network timeouts.
    void refreshAccess();
    return restored;
  }, []);

  const value = useMemo(
    () => ({ state, refresh, startTrial, purchase, restore }),
    [state, refresh, startTrial, purchase, restore],
  );

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}
