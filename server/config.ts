export const requireVerifiedEmail = () => process.env.REQUIRE_VERIFIED_EMAIL === 'true';
export const registrationOpen = () => process.env.REGISTRATION_OPEN !== 'false';
export function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const errors: string[] = [];
  if (process.env.APP_URL) {
    try {
      const url = new URL(process.env.APP_URL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        errors.push('APP_URL 必须是无路径和凭据的地址');
    } catch {
      errors.push('APP_URL 地址格式无效');
    }
  }
  if (process.env.COOKIE_SECURE !== 'true' && /^https:\/\//i.test(process.env.APP_URL || ''))
    errors.push('HTTPS 公开地址需要 COOKIE_SECURE=true');
  try {
    const db = new URL(process.env.DATABASE_URL || '');
    if (
      !['postgres:', 'postgresql:'].includes(db.protocol) ||
      decodeURIComponent(db.password).length < 24 ||
      /^(couple|postgres|replace)/i.test(decodeURIComponent(db.password))
    )
      errors.push('DATABASE_URL 需要至少 24 位随机数据库密码');
  } catch {
    errors.push('需要有效的 DATABASE_URL');
  }
  if (process.env.SUPPORT_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SUPPORT_EMAIL))
    errors.push('SUPPORT_EMAIL 格式无效');
  if (errors.length) throw new Error(`生产配置检查未通过：${errors.join('；')}`);
}
