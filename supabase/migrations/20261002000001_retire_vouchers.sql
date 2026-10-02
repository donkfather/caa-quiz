-- Retire promo codes (vouchers).
--
-- Ads and the remove-ads purchase are replaced by a 5-day trial followed by a
-- one-time unlock (20261002000000_trials.sql). Vouchers go with them: only
-- test codes were ever issued.
--
-- History: vouchers, voucher_redemptions, check_ads_free(), try_redeem_voucher()
-- and redeem_voucher() were created by hand in Supabase Studio and never
-- existed in a migration. forget_device() did (20260514000000_forget_device.sql)
-- and is kept, reports-only — see below.
-- Before writing this, prod was checked for anything else depending on them:
-- no views, triggers or other functions do. The only references are one foreign
-- key (voucher_redemptions -> vouchers) and one RLS policy on
-- voucher_redemptions, both of which are dropped along with their tables.
--
-- Old clients still in the field are unaffected:
--   • their voucher check treats an RPC error as "unknown" and keeps the
--     current state. On prod, check_ads_free() and try_redeem_voucher() were
--     already not executable by anon when this was written, so those calls
--     were already failing;
--   • their "Șterge toate datele" button calls forget_device(p_device_id) on a
--     best-effort basis, ignores the result and clears local storage either
--     way. forget_device() is therefore KEPT (see below), so for them it keeps
--     doing what it did for question reports.
--
-- forget_device() is NOT dropped: it also deleted the device's rows from
-- question_reports, and that server-side erasure stays. It is redefined below
-- to delete from question_reports only (the voucher table goes away). The new
-- client calls it too, from the same button, with the same random report id
-- (src/lib/dataReset.ts). Signature, SECURITY DEFINER, search_path and grants
-- are kept exactly as prod had them before this migration (checked read-only:
-- pg_get_functiondef + proacl = postgres, anon, authenticated, service_role;
-- nothing for PUBLIC). It deliberately does NOT touch public.trials: the trial
-- record is what stops a wipe from restarting the trial.
--
-- No CASCADE, on purpose: if something unexpected now depends on these
-- objects, this migration should fail loudly rather than quietly drop it.

-- Redefine first, so forget_device() never references a dropped table.
CREATE OR REPLACE FUNCTION public.forget_device(p_device_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.question_reports WHERE device_id = p_device_id;
END;
$$;

COMMENT ON FUNCTION public.forget_device(TEXT) IS
  'Deletes the question reports filed under this random report device id. Called by the in-app "Șterge toate datele" button (old and new clients). Never touches public.trials.';

-- CREATE OR REPLACE keeps the existing ACL; restated so a fresh database ends
-- up identical to prod.
REVOKE ALL ON FUNCTION public.forget_device(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forget_device(TEXT) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.check_ads_free(TEXT);
DROP FUNCTION IF EXISTS public.try_redeem_voucher(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.redeem_voucher(UUID);

DROP TABLE IF EXISTS public.voucher_redemptions, public.vouchers;
