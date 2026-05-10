// Dashboard runtime config. The deploy step replaces these placeholders
// with real values via Cloudflare Pages environment-variable injection
// (see scripts/dashboard/build.sh). For local `wrangler dev`, fill them in
// directly here.

export const SUPABASE_URL = "__SUPABASE_URL__";
export const SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";
export const ADMIN_EMAIL = "popescut94@gmail.com";
