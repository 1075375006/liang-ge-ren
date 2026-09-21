import 'dotenv/config';
import { migrate, pool } from '../server/db.js';
try {
  await migrate();
  console.log('数据库迁移完成。');
} finally {
  await pool.end();
}
