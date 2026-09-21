import 'dotenv/config';
import { buildApp } from '../server/app.js';
import { migrate, pool, query } from '../server/db.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('演示数据仅供本地开发，生产环境禁止执行。');
await migrate();
if ((await query('SELECT count(*) AS n FROM users')).rows[0].n !== '0') {
  console.log('数据库已有用户，未添加或修改演示数据。');
  await pool.end();
  process.exit(0);
}
const app = await buildApp();
const password = 'DemoCouple2026!';
async function call(url: string, cookie: string | undefined, payload?: Record<string, unknown>) {
  const result = await app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url: `/api${url}`,
    headers: cookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload }),
  });
  if (result.statusCode >= 400) throw new Error(`${url}: ${result.body}`);
  const header = result.headers['set-cookie'];
  return {
    data: result.json(),
    cookie: (Array.isArray(header) ? header[0] : header)?.split(';')[0],
  };
}
try {
  const one = await call('/auth/register', undefined, {
    name: '小满',
    email: 'xiaoman@example.test',
    password,
  });
  const two = await call('/auth/register', undefined, {
    name: '安安',
    email: 'anan@example.test',
    password,
  });
  const first = one.cookie!,
    second = two.cookie!;
  await call('/spaces', first, { name: '小满和安安的小日子' });
  const space = (await call('/bootstrap', first)).data.space;
  await call('/spaces/join', second, { code: space.inviteCode });

  async function task(
    title: string,
    description: string,
    reward: number,
    mode: 'RACE' | 'ASSIGNED',
    creator: string,
    stage = 'OPEN',
  ) {
    const item = (await call('/tasks', creator, { title, description, reward, mode })).data.task;
    if (stage !== 'OPEN') {
      const claimant = creator === first ? second : first;
      await call(`/tasks/${item.id}/claim`, claimant, {});
      if (stage === 'SUBMITTED' || stage === 'APPROVED')
        await call(`/tasks/${item.id}/submit`, claimant, {
          submission: '认真完成啦，等你来验收这份小小的心意。',
        });
      if (stage === 'APPROVED') await call(`/tasks/${item.id}/review`, creator, { approve: true });
    }
  }
  await task(
    '一起整理周末的旅行照片',
    '选出最喜欢的十张，写下当时的心情。',
    100,
    'ASSIGNED',
    second,
    'APPROVED',
  );
  await task(
    '为你准备一顿丰盛的晚餐',
    '认真做了三菜一汤，还记得你不吃香菜。',
    140,
    'ASSIGNED',
    second,
    'APPROVED',
  );
  await task(
    '照顾阳台上的小植物',
    '给绿萝浇水，把晒够太阳的花搬回去。',
    180,
    'ASSIGNED',
    first,
    'APPROVED',
  );
  await task('今晚的碗，谁来承包？', '饭后把碗洗好，顺手擦干净料理台。', 30, 'RACE', second);
  await task('一起散步 30 分钟', '吃过晚饭去小区走走，路上少看手机。', 20, 'ASSIGNED', second);
  await task(
    '给家里的绿植浇水',
    '摸摸土，干了再浇，也看看有没有黄叶。',
    15,
    'ASSIGNED',
    second,
    'CLAIMED',
  );
  await task(
    '为你准备明天的早餐',
    '牛奶、鸡蛋和你喜欢的全麦吐司。',
    25,
    'ASSIGNED',
    first,
    'SUBMITTED',
  );

  const products = [
    {
      title: '专属肩颈按摩券',
      description: '忙碌的一天结束，享受 20 分钟专属按摩。',
      emoji: '💆',
      price: 80,
      stock: 5,
    },
    {
      title: '周末电影之夜',
      description: '片单你来选，爆米花和饮料我来准备。',
      emoji: '🎬',
      price: 120,
      stock: 3,
    },
    {
      title: '一杯满分奶茶',
      description: '甜度、冰量和小料，全都听你的。',
      emoji: '🧋',
      price: 60,
      stock: 10,
    },
    {
      title: '一次说走就走的约会',
      description: '留出一个下午，我们去探索一家新的小店。',
      emoji: '🎡',
      price: 300,
      stock: 2,
    },
  ];
  for (const product of products) await call('/products', second, product);
  await call('/products', first, {
    title: '不用早起的周末',
    description: '早餐和家务交给我，你只管好好睡个懒觉。',
    emoji: '🥐',
    price: 100,
    stock: 4,
  });
  await call('/schedules', second, {
    title: '每天说一句晚安',
    description: '认真问问今天过得怎么样。',
    reward: 5,
    mode: 'ASSIGNED',
    kind: 'DAILY',
    time: '22:00',
    durationHours: 2,
  });
  console.log('演示空间已建立，全部积分均通过任务审核产生。');
  console.log('账号：xiaoman@example.test / anan@example.test');
  console.log(`演示密码：${password}`);
} finally {
  await app.close();
  await pool.end();
}
