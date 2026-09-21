// Verify connection, TLS and credentials without sending any message.
import nodemailer from 'nodemailer';

if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
  console.error('SMTP_HOST 和 SMTP_FROM 未配置');
  process.exit(1);
}
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: /^(true|1)$/i.test(process.env.SMTP_SECURE || 'false'),
  requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
    : undefined,
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
});
try {
  await transport.verify();
  console.log('SMTP 连接检查通过（按当前 TLS 与认证配置，未发送邮件）');
} catch (error) {
  console.error(`SMTP 检查失败：${error.code || 'UNKNOWN'}。请核对主机、端口、TLS 设置和授权凭据。`);
  process.exitCode = 1;
} finally {
  transport.close();
}
