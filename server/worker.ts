import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { closePool } from './db.js';
import { tick } from './jobs.js';

const controller = new AbortController();
let stopping = false;
function stop() {
  stopping = true;
  controller.abort();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.info('[worker] 定时任务与邮件工作进程已启动');
try {
  while (!stopping) {
    const started = Date.now();
    try {
      const result = await tick();
      if (result.scheduler.created || result.scheduler.expired || result.mail.processed) {
        console.info('[worker]', JSON.stringify(result));
      }
    } catch {
      console.error('[worker] 本轮执行失败，15 秒后自动重试；请检查数据库与运行状态');
    }
    if (!stopping) {
      await delay(Math.max(1000, 15_000 - (Date.now() - started)), undefined, {
        signal: controller.signal,
      }).catch((error) => {
        if (error?.name !== 'AbortError') throw error;
      });
    }
  }
} finally {
  await closePool();
  console.info('[worker] 工作进程已退出');
}
