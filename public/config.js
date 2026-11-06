// Public client config. The anon key is safe to ship: access is enforced by
// row-level security (see supabase/schema.sql). Never put a service_role key here.
window.APP_CONFIG = {
  AUTH_ENABLED: false,          // flip to true once the Supabase project below is set up
  SUPABASE_URL: '',             // e.g. https://abcdxyz.supabase.co
  SUPABASE_ANON_KEY: '',
};
