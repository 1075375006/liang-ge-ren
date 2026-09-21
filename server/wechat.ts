import { randomBytes } from 'node:crypto';

export type WechatProfile = {
  type: string;
  social_uid: string;
  nickname?: string;
  faceimg?: string;
};

export function wechatEnabled(): boolean {
  return (
    /^(1|true|yes)$/i.test(process.env.WECHAT_LOGIN_ENABLED ?? '') &&
    Boolean(process.env.BEICHEN_APP_ID && process.env.BEICHEN_APP_KEY)
  );
}

export function appId(): string {
  return process.env.BEICHEN_APP_ID ?? '';
}
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function providerUrl(params: Record<string, string>): string {
  const url = new URL('https://u.beichenwl.cn/connect.php');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function providerJson(
  fetchImpl: typeof fetch,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(providerUrl(params), {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('provider_invalid_json');
  return body as Record<string, unknown>;
}

export async function authorizationUrl(
  fetchImpl: typeof fetch,
  redirectUri: string,
): Promise<string> {
  const body = await providerJson(fetchImpl, {
    act: 'login',
    appid: appId(),
    appkey: process.env.BEICHEN_APP_KEY ?? '',
    type: 'wx',
    redirect_uri: redirectUri,
  });
  if (body.code !== 0 || typeof body.url !== 'string') throw new Error('provider_login_failed');
  const url = new URL(body.url);
  if (
    url.origin !== 'https://u.beichenwl.cn' ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) => key.toLowerCase() === 'appkey')
  )
    throw new Error('provider_url_invalid');
  // Never forward a credential if an upstream response unexpectedly echoes it.
  const key = process.env.BEICHEN_APP_KEY ?? '';
  let decodedUrl = url.toString();
  for (let round = 0; round < 3; round++) {
    if (key && decodedUrl.includes(key)) throw new Error('provider_url_invalid');
    try {
      const decoded = decodeURIComponent(decodedUrl);
      if (decoded === decodedUrl) break;
      decodedUrl = decoded;
    } catch {
      break;
    }
  }
  return url.toString();
}

export async function exchangeCode(fetchImpl: typeof fetch, code: string): Promise<WechatProfile> {
  const body = await providerJson(fetchImpl, {
    act: 'callback',
    appid: appId(),
    appkey: process.env.BEICHEN_APP_KEY ?? '',
    type: 'wx',
    code,
  });
  if (
    body.code !== 0 ||
    body.type !== 'wx' ||
    typeof body.social_uid !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(body.social_uid)
  ) {
    throw new Error(body.code === 2 ? 'provider_pending' : 'provider_callback_failed');
  }
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim().slice(0, 40) : '';
  const faceimg =
    typeof body.faceimg === 'string' && /^https:\/\//i.test(body.faceimg)
      ? body.faceimg.slice(0, 500)
      : null;
  return {
    type: 'wx',
    social_uid: body.social_uid,
    nickname: nickname || '微信用户',
    faceimg: faceimg ?? undefined,
  };
}

export function callbackPath(state: string): string {
  return `/api/auth/wechat/callback/${state}`;
}
