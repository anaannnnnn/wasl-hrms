// SSO landing: /sso.html#<base64url {token,user}> — stores the session the same way the password login does.
import { applyTheme } from './ext.js';
applyTheme();
const app = document.getElementById('app');
try {
  const b64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const { token, user } = JSON.parse(json);
  if (!token || !user) throw new Error('missing');
  localStorage.setItem('wasl_token', token); localStorage.setItem('wasl_user', JSON.stringify(user));
  history.replaceState(null, '', '/sso.html'); // don't leave the token in the address bar / history
  const staff = (user.roles || []).some((r) => r !== 'employee');
  location.replace(staff ? '/' : '/employee');
} catch {
  app.innerHTML = '<div class="pcard"><h1>Sign-in failed</h1><p class="pmuted">The single sign-on response was incomplete. <a href="/">Back to sign in</a></p></div>';
}
