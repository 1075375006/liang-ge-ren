import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { authorizationUrl, exchangeCode } from '../server/wechat.js';

const execFileAsync = promisify(execFile);

test('真实 Fastify 请求日志不包含微信状态、授权码或请求凭据', async () => {
  const state = '9a'.repeat(32);
  const code = 'private-oauth-code-for-log-test';
  const cookie = 'private-cookie-value-for-log-test';
  const authorization = 'private-authorization-for-log-test';
  const appModule = new URL('../server/app.ts', import.meta.url).href;
  const dbModule = new URL('../server/db.ts', import.meta.url).href;
  // Capture Pino's real stdout in another process. No session or nonce cookie is
  // supplied, so the real callback exits before any database or provider call.
  const source = `
    import assert from 'node:assert/strict';
    const { buildApp } = await import(${JSON.stringify(appModule)});
    const { closePool } = await import(${JSON.stringify(dbModule)});
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: ${JSON.stringify(`/api/auth/wechat/callback/${state}?type=wx&code=${code}`)},
        headers: {
          cookie: ${JSON.stringify(`test_private_cookie=${cookie}`)},
          authorization: ${JSON.stringify(`Bearer ${authorization}`)},
        },
      });
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers.location, '/?wechat=error&reason=invalid_state');
    } finally {
      await app.close();
      await closePool();
    }
  `;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 10_000,
      env: {
        ...process.env,
        LOG_LEVEL: 'info',
        WECHAT_LOGIN_ENABLED: 'true',
        BEICHEN_APP_ID: 'logging-test-app',
        BEICHEN_APP_KEY: 'logging-test-provider-key',
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/no_database_expected',
      },
    },
  );
  const logs = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const requests = logs.filter((line) => line.msg === 'incoming request');
  assert.equal(requests.length, 1, 'the real incoming request must be logged');
  assert.deepEqual(requests[0].req, {
    method: 'GET',
    url: '/api/auth/wechat/callback/[redacted]',
  });
  assert.ok(logs.some((line) => line.msg === 'request completed' && line.res.statusCode === 303));
  for (const secret of [state, code, cookie, authorization, 'logging-test-provider-key']) {
    assert.ok(!(stdout + stderr).includes(secret), `request logs leaked ${secret}`);
  }
});

test('微信授权和身份交换请求会通过真实 AbortSignal 中止超时上游', async (t) => {
  // Shorten the platform's 10-second deadline only inside this test, retaining
  // Node's real AbortSignal timeout and actual abort event propagation.
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadlines.push(milliseconds);
    return realTimeout(5);
  });
  const receivedSignals: AbortSignal[] = [];
  const stalledProvider: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal, 'provider request needs a cancellation signal');
    receivedSignals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  // AbortSignal's internal timer is unref'd; this bounded guard both keeps the
  // event loop alive and turns a missing cancellation path into a fast failure.
  let guard: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    guard = setTimeout(() => reject(new Error('provider did not abort')), 1000);
  });
  try {
    await Promise.race([
      Promise.all([
        assert.rejects(authorizationUrl(stalledProvider, 'https://example.test/callback'), {
          name: 'TimeoutError',
        }),
        assert.rejects(exchangeCode(stalledProvider, 'test-code'), { name: 'TimeoutError' }),
      ]),
      deadline,
    ]);
    assert.deepEqual(deadlines, [10_000, 10_000]);
    assert.equal(receivedSignals.length, 2);
    assert.ok(receivedSignals.every((signal) => signal.aborted));
  } finally {
    clearTimeout(guard);
  }
});
