import { smtpConfigured } from './notify.js';

export const requireVerifiedEmail = () => process.env.REQUIRE_VERIFIED_EMAIL === 'true';
export const registrationOpen = () => process.env.REGISTRATION_OPEN !== 'false';
export function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const errors: string[] = [];
  try {
    const url = new URL(process.env.APP_URL || '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      errors.push('APP_URL 必须是无路径和凭据的 HTTPS 站点地址');
  } catch {
    errors.push('需要配置公开 HTTPS 地址 APP_URL');
  }
  if (process.env.COOKIE_SECURE !== 'true') errors.push('生产环境需要 COOKIE_SECURE=true');
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
  if (requireVerifiedEmail() && !smtpConfigured())
    errors.push('启用邮箱验证需要 SMTP_HOST 和 SMTP_FROM');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SUPPORT_EMAIL || ''))
    errors.push('需要配置可联系的 SUPPORT_EMAIL');
  if (errors.length) throw new Error(`生产配置检查未通过：${errors.join('；')}`);
}
