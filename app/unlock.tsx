import { useEffect } from "react";
import { useRouter } from "expo-router";
import Paywall from "../src/components/Paywall";
import { useAccess } from "../src/lib/AccessContext";

// The offer, opened on purpose from the app (the trial banner's "Deblochează")
// rather than by the start-up gate. Same screen as the start-up offer; closing
// it goes back to where the user was.
export default function UnlockScreen() {
  const router = useRouter();
  const { state } = useAccess();

  // Bought (or restored) while it was open: the job is done, go back.
  useEffect(() => {
    if (state?.kind === "unlocked" && router.canGoBack()) router.back();
  }, [state?.kind]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const daysLeft = state?.kind === "trial" ? state.daysLeft : 0;
  return <Paywall trial={{ daysLeft, onContinue: close }} />;
}
