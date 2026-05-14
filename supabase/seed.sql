-- Seed for the LOCAL Supabase stack only.
-- Runs automatically after migrations on `supabase start` and `supabase db reset`.

-- ───────────────── admin auth user ─────────────────
-- popescut94@gmail.com / localdev
-- GoTrue uses sql.Scan with non-nullable Go strings for the various *_token
-- columns, so they MUST be empty strings rather than NULL.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token,
  email_change_token_new, email_change_token_current,
  email_change, phone_change, phone_change_token,
  reauthentication_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated', 'popescut94@gmail.com',
  crypt('localdev', gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"email":"popescut94@gmail.com"}'::jsonb,
  '', '', '', '', '', '', '', ''
) ON CONFLICT (id) DO UPDATE
   SET email_confirmed_at = EXCLUDED.email_confirmed_at,
       encrypted_password = EXCLUDED.encrypted_password,
       confirmation_token         = '',
       recovery_token             = '',
       email_change_token_new     = '',
       email_change_token_current = '',
       email_change               = '',
       phone_change               = '',
       phone_change_token         = '',
       reauthentication_token     = '';

-- Identity row, so Supabase Auth recognises this account.
INSERT INTO auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('sub','11111111-1111-1111-1111-111111111111','email','popescut94@gmail.com'),
  'email', NOW(), NOW(), NOW()
) ON CONFLICT (provider_id, provider) DO NOTHING;

-- ───────────────── admins allowlist ─────────────────
INSERT INTO public.admins (email, is_owner)
  VALUES ('popescut94@gmail.com', TRUE)
  ON CONFLICT (email) DO UPDATE SET is_owner = TRUE;

-- ───────────────── sample questions (so the editor isn't empty) ─────────────────
INSERT INTO public.questions (question, options, correct, topic, license) VALUES
  ('Care este distanța minimă față de o navă cu manevra limitată?',
   ARRAY['100 m', '200 m', '500 m'], 2, 'colreg', ARRAY['C','D']),
  ('Cum se așază un cârlig prins de un ochet?',
   ARRAY['Cu vârful în jos', 'Cu vârful lateral', 'Cu vârful în sus'], 2, 'seamanship', ARRAY['C','D']),
  ('Cu cât se pot alungi parâmele sintetice înainte de rupere?',
   ARRAY['1…5%', '5…10%', '15…30%'], 2, 'seamanship', ARRAY['C','D'])
ON CONFLICT DO NOTHING;
