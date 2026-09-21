import 'dotenv/config';
import { buildApp } from './app.js';
import { pool } from './db.js';
import { validateProductionConfig } from './config.js';
validateProductionConfig();

const app = await buildApp();
const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.once('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
try {
  await app.listen({
    port: Number(process.env.PORT ?? 33442),
    host: process.env.HOST ?? '0.0.0.0',
  });
  console.log(`两个人已启动：http://localhost:${process.env.PORT ?? 33442}`);
} catch (error) {
  app.log.error(error);
  console.error('服务启动失败，请检查端口和环境配置。');
  await pool.end();
  process.exitCode = 1;
}
