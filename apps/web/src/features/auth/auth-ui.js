import { getSession, signIn, signOut, signUp } from './session.js';
import { requestJson } from '../../services/api-client.js';

export function mountAuth() {
  const dialog = document.getElementById('auth-dialog');
  const trigger = document.getElementById('auth-state-button');
  const form = document.getElementById('auth-form');
  const status = document.getElementById('auth-status');
  const title = document.getElementById('auth-title');
  const submit = document.getElementById('auth-submit');
  const signupFields = document.getElementById('auth-signup-fields');
  const username = document.getElementById('auth-username');
  const password = document.getElementById('auth-password');
  if (!dialog || !trigger || !form) return;
  let mode = 'signin';

  function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'signin';
    document.querySelectorAll('[data-auth-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.authMode === mode));
    if (title) title.textContent = mode === 'signup' ? 'Create your ZUNO account.' : 'Welcome back.';
    if (submit) submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    if (signupFields) signupFields.hidden = mode !== 'signup';
    if (username) username.required = mode === 'signup';
    if (password) password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    if (status) status.textContent = '';
  }

  function refreshTrigger() {
    const session = getSession();
    trigger.textContent = session ? 'Sign out' : 'Sign in';
    trigger.setAttribute('aria-label', session ? 'Sign out of ZUNO' : 'Sign in to ZUNO');
    trigger.title = session && session.user && session.user.email ? 'Signed in as ' + session.user.email : 'Sign in to ZUNO';
  }

  trigger.addEventListener('click', async () => {
    if (getSession()) {
      trigger.disabled = true;
      try {
        await signOut();
        if (status) status.textContent = 'Signed out.';
      } finally {
        trigger.disabled = false;
        refreshTrigger();
      }
      return;
    }
    setMode('signin');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });

  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.authMode)));
  document.querySelectorAll('[data-action="cancel-auth"]').forEach((button) => button.addEventListener('click', () => dialog.close()));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit) submit.disabled = true;
    if (status) status.textContent = mode === 'signup' ? 'Creating your account…' : 'Signing in…';
    try {
      if (mode === 'signup') {
        const result = await signUp({
          email: form.elements.email.value,
          password: form.elements.password.value,
          username: form.elements.username.value.trim(),
          displayName: form.elements.displayName.value.trim() || form.elements.username.value.trim()
        });
        if (!result.access_token) {
          if (status) status.textContent = 'Account request accepted. Confirm your email if required, then sign in.';
          return;
        }
      } else {
        await signIn(form.elements.email.value, form.elements.password.value);
      }

      const result = await requestJson('/api/profile/me');
      refreshTrigger();
      if (status) status.textContent = 'Signed in as @' + result.profile.username + '.';
      window.dispatchEvent(new CustomEvent('zuno:session-change'));
      window.setTimeout(() => { if (dialog.open) dialog.close(); }, 450);
    } catch (error) {
      refreshTrigger();
      const message = error.code === 'PROFILE_NOT_PROVISIONED'
        ? 'Authentication succeeded, but this account has no ZUNO profile. Check the Auth profile-provisioning migration and trigger.'
        : (error.message || 'Authentication failed.');
      if (status) status.textContent = message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  window.addEventListener('zuno:session-change', refreshTrigger);
  setMode('signin');
  refreshTrigger();
}
