/* Optional Supabase auth + cloud sync. Inert unless APP_CONFIG.AUTH_ENABLED. */
'use strict';
(function () {
  const cfg = window.APP_CONFIG || {};
  const enabled = !!(cfg.AUTH_ENABLED && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  let client = null;
  let user = null;

  function loadLib() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const s = document.createElement('script');
      s.src = LIB; s.onload = resolve; s.onerror = () => reject(new Error('Could not load auth library'));
      document.head.appendChild(s);
    });
  }

  async function init(onChange) {
    if (!enabled) return false;
    try {
      await loadLib();
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      const { data } = await client.auth.getSession();
      user = data.session ? data.session.user : null;
      client.auth.onAuthStateChange((_evt, session) => {
        const next = session ? session.user : null;
        if ((next && next.id) !== (user && user.id)) { user = next; onChange(user); }
      });
      onChange(user);
      return true;
    } catch (err) {
      console.warn('Auth unavailable:', err.message);
      return false;
    }
  }

  const unwrap = ({ data, error }) => { if (error) throw error; return data; };

  window.Auth = {
    enabled,
    user: () => user,
    signIn: (email, password) => client.auth.signInWithPassword({ email, password }).then(unwrap),
    signUp: (email, password) => client.auth.signUp({ email, password }).then(unwrap),
    signOut: () => client.auth.signOut(),
    reset: (email) => client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(unwrap),
    async pull() {
      const row = unwrap(await client.from('portfolios').select('data,updated_at').eq('user_id', user.id).maybeSingle());
      return row ? row.data : null;
    },
    async push(data) {
      unwrap(await client.from('portfolios').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() }));
    },
    async plan() {
      const row = unwrap(await client.from('profiles').select('plan').eq('id', user.id).maybeSingle());
      return row ? row.plan : 'free';
    },
  };
})();
