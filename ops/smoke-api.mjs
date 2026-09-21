// Runs inside an isolated Docker smoke project, with only local Mailpit recipients.
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:33442';
assert.equal(process.env.SMTP_PASS, String.raw`smoke\literal$dollar'quote`);
async function request(path, data, cookie = '', expected = 200) {
  const response = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://localhost', Cookie: cookie },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(body)}`);
  return { body, cookie: response.headers.get('set-cookie') || cookie };
}

async function waitForToken(email, pattern) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const listing = await fetch('http://mailpit:8025/api/v1/messages').then((r) => r.json());
    for (const item of listing.messages || []) {
      if (!item.To?.some((to) => to.Address === email)) continue;
      const message = await fetch(`http://mailpit:8025/api/v1/message/${item.ID}`).then((r) => r.json());
      const match = message.Text?.match(pattern);
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Local SMTP did not receive the expected message for ${email}`);
}

const accounts = [];
for (const name of ['smoke-one', 'smoke-two']) {
  const email = `${name}@example.test`;
  const registered = await request('/api/auth/register', {
    name, email, password: 'SmokeOnly-2026-Strong!', acceptTerms: true,
  });
  assert.match(registered.cookie, /HttpOnly/i);
  assert.match(registered.cookie, /Secure/i);
  assert.match(registered.cookie, /SameSite=Lax/i);
  const cookie = registered.cookie.split(';')[0];
  await request('/api/spaces', { name: 'Before verification' }, cookie, 403);
  const token = await waitForToken(email, /verify=([a-f0-9]{64})/);
  await request('/api/auth/verify', { token }, cookie);
  accounts.push({ email, cookie });
}
const { body: created } = await request('/api/spaces', { name: 'Docker smoke couple' }, accounts[0].cookie);
await request('/api/spaces/join', { code: created.space.inviteCode }, accounts[1].cookie);
for (const { cookie } of accounts) {
  const { body } = await request('/api/bootstrap', undefined, cookie);
  assert.equal(body.space.id, created.space.id);
  assert.equal(body.user.emailVerified, true);
  assert.ok(body.partner);
}
await request('/api/auth/password/forgot', { email: accounts[0].email });
const resetToken = await waitForToken(accounts[0].email, /reset-password=([a-f0-9]{64})/);
await request('/api/auth/password/reset', { token: resetToken, password: 'SmokeOnly-Changed-2026!' });
await request('/api/auth/login', { email: accounts[0].email, password: 'SmokeOnly-Changed-2026!' });
const { body: oldSession } = await request('/api/bootstrap', undefined, accounts[0].cookie);
assert.equal(oldSession.user, null);
await request('/api/auth/password/reset', { token: resetToken, password: 'SmokeOnly-Replay-2026!' }, '', 400);
console.log('PASS: production cookies, verified registration, local SMTP delivery, pairing, password reset, revoked session, token replay protection');
