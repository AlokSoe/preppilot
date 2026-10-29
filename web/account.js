import { el } from './chat.js';

/**
 * Accounts in the browser. When the server runs with AUTH=accounts and
 * nobody is logged in, a sign-in screen covers the app. The Settings tab
 * manages the API key (only its last 4 characters ever come back), shows
 * today's usage, and logs out.
 */

/** @returns {Promise<any>} */
export async function loadMe() {
  try {
    const res = await fetch('/api/me');
    return res.ok ? await res.json() : { accounts: false };
  } catch {
    return { accounts: false };
  }
}

/** Full-screen sign in / sign up. Reloads the page once signed in. */
export function showAuthScreen() {
  const screen = el('section', 'auth-screen');
  const card = el('div', 'panel auth-card');
  const title = el('h1', '', 'Sign in to PrepPilot');
  const form = /** @type {HTMLFormElement} */ (el('form', 'auth-form'));
  const email = field('email', 'Email', 'email', 'username');
  const password = field('password', 'Password (8+ characters)', 'password', 'current-password');
  const submit = el('button', '', 'Sign in');
  submit.type = 'submit';
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  const toggle = el('button', 'link-button', 'New here? Create an account');
  toggle.type = 'button';
  let mode = 'login';

  toggle.addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    title.textContent = mode === 'login' ? 'Sign in to PrepPilot' : 'Create your account';
    submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    toggle.textContent = mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
    password.input.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    error.textContent = '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.input.value, password: password.input.value }),
      });
      if (res.ok) return location.reload();
      error.textContent = (await res.json().catch(() => null))?.error?.message ?? `Failed (HTTP ${res.status}).`;
    } catch {
      error.textContent = 'Could not reach the server.';
    } finally {
      submit.disabled = false;
    }
  });

  form.append(email.label, password.label, submit, error);
  card.append(
    title,
    el('p', 'meta', 'Practise JavaScript interviews from your own notes. Free demo included; add your own API key for unlimited use.'),
    form,
    toggle,
  );
  screen.append(card);
  document.body.append(screen);
  email.input.focus();
}

/**
 * Settings tab: API key, usage, logout.
 * @param {HTMLElement} root
 */
export async function showSettings(root) {
  const me = await loadMe();
  if (!me.accounts) {
    root.replaceChildren(
      el('h1', '', 'Settings'),
      el('p', '', 'This server runs in single-user mode. It uses the API key from its ANTHROPIC_API_KEY environment variable.'),
    );
    return;
  }
  if (!me.user) return;

  const nodes = [el('h1', '', 'Settings'), el('p', 'meta', `Signed in as ${me.user.email}`)];

  // ---- API key
  const keyPanel = el('section', 'panel');
  keyPanel.append(el('h2', '', 'Your API key'));
  if (me.keys.length) {
    for (const key of me.keys) {
      const row = el('p');
      const remove = el('button', 'link-button', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm('Remove this key? You will be back on the free demo.')) return;
        await fetch(`/api/keys/${encodeURIComponent(key.provider)}`, { method: 'DELETE' });
        showSettings(root);
      });
      row.append(`${providerLabel(key.provider)} key ending in …${key.last4} `, remove);
      keyPanel.append(row);
    }
  } else {
    keyPanel.append(
      el(
        'p',
        '',
        me.tier === 'demo'
          ? `You're on the free demo: ${me.demo.messagesLeft} of ${me.demo.messagesPerDay} messages left today. Build mode and new problems need your own key.`
          : 'Add an API key to use the AI features.',
      ),
    );
  }
  const form = /** @type {HTMLFormElement} */ (el('form', 'key-form'));
  const keyField = field('apiKey', me.keys.length ? 'Replace with a new key' : 'Anthropic API key', 'password', 'off');
  keyField.input.placeholder = 'sk-ant-…';
  const save = el('button', '', 'Check and save');
  save.type = 'submit';
  const status = el('p', 'note');
  status.setAttribute('role', 'status');
  form.append(keyField.label, save, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = 'Checking the key with the provider…';
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'claude', apiKey: keyField.input.value }),
      });
      keyField.input.value = ''; // never keep the key in the page longer than needed
      if (res.ok) return showSettings(root);
      status.textContent = (await res.json().catch(() => null))?.error?.message ?? `Failed (HTTP ${res.status}).`;
    } catch {
      status.textContent = 'Could not reach the server.';
    } finally {
      save.disabled = false;
    }
  });
  keyPanel.append(
    form,
    el(
      'p',
      'meta',
      'Your key is checked, then stored encrypted (AES-256-GCM). It is never shown again, never logged, and never sent to the code sandbox. Remove it any time.',
    ),
  );
  nodes.push(keyPanel);

  // ---- Usage
  const usagePanel = el('section', 'panel');
  const own = me.usage.own;
  const demo = me.usage.demo;
  usagePanel.append(
    el('h2', '', 'Usage today'),
    el('p', '', `Your key: ${own.requests} requests · ${own.input.toLocaleString()} input / ${own.output.toLocaleString()} output tokens`),
    el('p', '', `Free demo: ${demo.requests} requests · ${(demo.input + demo.output).toLocaleString()} tokens`),
  );
  nodes.push(usagePanel);

  // ---- Logout
  const logout = el('button', 'ghost', 'Sign out');
  logout.type = 'button';
  logout.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    location.reload();
  });
  nodes.push(logout);
  root.replaceChildren(...nodes);
}

function providerLabel(provider) {
  return { claude: 'Anthropic (Claude)' }[provider] ?? provider;
}

/** A labelled input. */
function field(name, labelText, type, autocomplete) {
  const label = el('label', 'field');
  const input = /** @type {HTMLInputElement} */ (el('input'));
  Object.assign(input, { name, type, required: true, autocomplete });
  label.append(el('span', '', labelText), input);
  return { label, input };
}
