import { consumeAuthRedirect, getSession, requestPasswordReset, resendSignupConfirmation, signIn, signOut, signUp, updatePassword } from './session.js';
import { requestJson } from '../../services/api-client.js';

function authErrorMessage(error) {
  const code = String(error && error.code || '').toLowerCase();
  const message = String(error && error.message || 'Authentication failed.');
  if (code.includes('over_email_send_rate_limit') || /email rate limit exceeded/i.test(message)) {
    return 'Supabase is blocking confirmation/reset emails because the project email limit is exhausted. ZUNO needs working custom SMTP before email verification and recovery can work. Avoid repeated retries.';
  }
  if (code === 'email_not_confirmed') {
    return 'Your email is not confirmed yet. Check your inbox or use Resend confirmation email below.';
  }
  if (/redirect.*not allowed|requested path is invalid/i.test(message)) {
    return 'Supabase is rejecting the ZUNO redirect URL. Add https://zuno-web-corrected.onrender.com/** to Supabase Auth URL Configuration, then retry.';
  }
  return message;
}

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
  const emailField = document.getElementById('auth-email-field');
  const emailInput = document.getElementById('auth-email');
  const passwordField = document.getElementById('auth-password-field');
  const recoveryFields = document.getElementById('auth-recovery-fields');
  const confirmPassword = document.getElementById('auth-confirm-password');
  const modeTabs = document.querySelector('.auth-mode-tabs');
  const forgotButton = document.getElementById('auth-forgot-password');
  const resendButton = document.getElementById('auth-resend-confirmation');
  if (!dialog || !trigger || !form) return;

  let mode = 'signin';
  let pendingConfirmationEmail = '';

  function setStatus(message) {
    if (status) status.textContent = message || '';
  }

  function setMode(next) {
    mode = ['signin', 'signup', 'forgot', 'recovery'].includes(next) ? next : 'signin';
    const isSignup = mode === 'signup';
    const isSignin = mode === 'signin';
    const isForgot = mode === 'forgot';
    const isRecovery = mode === 'recovery';

    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.authMode === mode);
    });
    if (modeTabs) modeTabs.hidden = isForgot || isRecovery;
    if (title) {
      title.textContent = isSignup ? 'Create your ZUNO account.'
        : isForgot ? 'Reset your password.'
        : isRecovery ? 'Choose a new password.'
        : 'Welcome back.';
    }
    if (submit) {
      submit.textContent = isSignup ? 'Create account'
        : isForgot ? 'Send reset link'
        : isRecovery ? 'Update password'
        : 'Sign in';
    }
    if (signupFields) signupFields.hidden = !isSignup;
    if (username) username.required = isSignup;
    if (emailField) emailField.hidden = isRecovery;
    if (emailInput) emailInput.required = !isRecovery;
    if (passwordField) passwordField.hidden = isForgot;
    if (password) {
      password.required = !isForgot;
      password.autocomplete = isSignup || isRecovery ? 'new-password' : 'current-password';
      password.minLength = isForgot ? 0 : 8;
    }
    if (recoveryFields) recoveryFields.hidden = !isRecovery;
    if (confirmPassword) confirmPassword.required = isRecovery;
    if (forgotButton) forgotButton.hidden = !isSignin;
    if (resendButton) resendButton.hidden = !pendingConfirmationEmail || !(isSignin || isSignup);
    setStatus('');
  }

  function openDialog() {
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
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
        setStatus('Signed out.');
      } catch (_) {
        setStatus('Signed out on this device.');
      } finally {
        trigger.disabled = false;
        refreshTrigger();
      }
      return;
    }
    setMode('signin');
    openDialog();
  });

  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.authMode));
  });
  document.querySelectorAll('[data-action="cancel-auth"]').forEach((button) => {
    button.addEventListener('click', () => dialog.close());
  });
  if (forgotButton) forgotButton.addEventListener('click', () => setMode('forgot'));

  if (resendButton) {
    resendButton.addEventListener('click', async () => {
      const email = pendingConfirmationEmail || (emailInput && emailInput.value.trim());
      if (!email) {
        setStatus('Enter your email address first.');
        return;
      }
      resendButton.disabled = true;
      try {
        await resendSignupConfirmation(email);
        pendingConfirmationEmail = email;
        setStatus('The confirmation request was accepted. Check your inbox and spam folder. If nothing arrives, the project email sender still needs to be configured.');
      } catch (error) {
        setStatus(authErrorMessage(error));
      } finally {
        resendButton.disabled = false;
        if (resendButton) resendButton.hidden = !pendingConfirmationEmail;
      }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit) submit.disabled = true;
    if (status) {
      setStatus(mode === 'signup' ? 'Creating your account…'
        : mode === 'forgot' ? 'Requesting a password reset…'
        : mode === 'recovery' ? 'Updating your password…'
        : 'Signing in…');
    }
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(emailInput.value);
        setStatus('The reset request was accepted. Check your inbox and spam folder. Email delivery depends on the project SMTP configuration.');
        return;
      }

      if (mode === 'recovery') {
        const newPassword = password.value;
        if (newPassword !== confirmPassword.value) throw new Error('The new passwords do not match.');
        await updatePassword(newPassword);
        await signOut();
        pendingConfirmationEmail = '';
        setMode('signin');
        setStatus('Password updated. Sign in using your new password.');
        refreshTrigger();
        return;
      }

      if (mode === 'signup') {
        const email = emailInput.value.trim();
        const result = await signUp({
          email,
          password: password.value,
          username: form.elements.username.value.trim(),
          displayName: form.elements.displayName.value.trim() || form.elements.username.value.trim()
        });
        if (!result.access_token) {
          pendingConfirmationEmail = email;
          if (resendButton) resendButton.hidden = false;
          setStatus('Account request accepted. Check your inbox to confirm your email. Use Resend confirmation email if needed.');
          return;
        }
      } else {
        await signIn(emailInput.value, password.value);
      }

      const result = await requestJson('/api/profile/me');
      pendingConfirmationEmail = '';
      if (resendButton) resendButton.hidden = true;
      refreshTrigger();
      setStatus('Signed in as @' + result.profile.username + '.');
      window.dispatchEvent(new CustomEvent('zuno:session-change'));
      window.setTimeout(() => { if (dialog.open) dialog.close(); }, 450);
    } catch (error) {
      refreshTrigger();
      const code = String(error && error.code || '').toLowerCase();
      if (code === 'email_not_confirmed') {
        pendingConfirmationEmail = emailInput.value.trim();
        if (resendButton) resendButton.hidden = false;
      }
      setStatus(authErrorMessage(error));
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  window.addEventListener('zuno:session-change', refreshTrigger);
  const callback = consumeAuthRedirect();
  setMode(callback && callback.type === 'recovery' ? 'recovery' : 'signin');
  refreshTrigger();

  if (callback && callback.error) {
    openDialog();
    setStatus(callback.error);
  } else if (callback && callback.type === 'recovery') {
    openDialog();
    setStatus('Password reset link validated. Choose a new password below.');
  } else if (callback && callback.type === 'confirmed') {
    openDialog();
    setStatus('Email confirmation complete if this address was verified. You can now sign in.');
  } else if (callback && callback.type === 'signup') {
    if (getSession()) {
      requestJson('/api/profile/me').then((result) => {
        refreshTrigger();
        setStatus('Email confirmed. Signed in as @' + result.profile.username + '.');
      }).catch(() => {
        openDialog();
        setStatus('Email confirmation completed. Sign in to continue.');
      });
    } else {
      openDialog();
      setStatus('Email confirmed. You can now sign in.');
    }
  }
}
