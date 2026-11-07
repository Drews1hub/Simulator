// Public client config. The anon key is safe to ship: access is enforced by
// row-level security (see supabase/schema.sql). Never put a service_role key here.
window.APP_CONFIG = {
  AUTH_ENABLED: true,
  SUPABASE_URL: 'https://aqpnvdonzsjdkrggmlfa.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable__z91nUksp8QwKQxOjcYaLg_FD5g0ZQz',
};
