-- Right-to-be-forgotten endpoint. Wipes all rows tied to an anonymous device id.
-- Called from the in-app "Șterge toate datele" button. Safe to call for unknown
-- device ids (no-op).

CREATE OR REPLACE FUNCTION public.forget_device(p_device_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.voucher_redemptions WHERE device_id = p_device_id;
  DELETE FROM public.question_reports WHERE device_id = p_device_id;
END;
$$;

REVOKE ALL ON FUNCTION public.forget_device(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forget_device(TEXT) TO anon, authenticated;
