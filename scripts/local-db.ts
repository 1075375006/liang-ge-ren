import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync } from 'node:fs';
import { cp, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

// PostgreSQL for Windows cannot initialise UTF-8 catalogs from a CJK binary path.
// Keep this optional development runtime in the current user's local app data.
if (process.platform === 'win32') {
  await startWindowsDatabase();
} else {
  const directory = resolve('.local/postgres');
  mkdirSync(resolve('.local'), { recursive: true });
  const database = new EmbeddedPostgres({
    databaseDir: directory,
    port: 55432,
    user: 'couple',
    password: 'couple_local_only',
    authMethod: 'scram-sha-256',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-messages=C'],
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: (message) => {
      if (process.env.DB_VERBOSE) console.log(String(message));
    },
    onError: (message) => {
      if (String(message).includes('FATAL')) console.error(String(message));
    },
  });

  if (!existsSync(resolve(directory, 'PG_VERSION'))) await database.initialise();
  await database.start();
  const client = database.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='couple'")).rowCount) {
    await client.query('CREATE DATABASE couple');
  }
  await client.end();
  console.log('开发数据库已启动：127.0.0.1:55432，数据保存在 .local/postgres。Ctrl+C 停止。');

  let stopping = false;
  const keepAlive = setInterval(() => {}, 60_000);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    await database.stop();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function startWindowsDatabase() {
  const base = resolve(process.env.LOCALAPPDATA ?? '.local', 'TwoOfUsDev');
  const runtime = resolve(base, 'postgres-17.6');
  const project = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  const data = resolve(base, project, 'data');
  const runFile = promisify(execFile);
  if (!existsSync(resolve(runtime, 'bin/initdb.exe'))) {
    await cp(resolve('node_modules/@embedded-postgres/windows-x64/native'), runtime, {
      recursive: true,
    });
  }
  mkdirSync(resolve(base, project), { recursive: true });
  if (!existsSync(resolve(data, 'PG_VERSION'))) {
    const passwordFile = resolve(base, project, 'init-password');
    await writeFile(passwordFile, 'couple_local_only\n');
    try {
      await runFile(
        resolve(runtime, 'bin/initdb.exe'),
        [
          '-D',
          data,
          '-U',
          'couple',
          '--auth=scram-sha-256',
          `--pwfile=${passwordFile}`,
          '--locale=C',
          '--encoding=UTF8',
          '--lc-messages=C',
        ],
        { windowsHide: true },
      );
    } finally {
      await unlink(passwordFile);
    }
  }
  const child = spawn(
    resolve(runtime, 'bin/postgres.exe'),
    ['-D', data, '-p', '55432', '-h', '127.0.0.1'],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let failure = '';
  child.stderr.on('data', (chunk) => {
    failure += String(chunk);
  });
  const connectionString = 'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(failure);
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='couple'")).rowCount)
        await client.query('CREATE DATABASE couple');
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await client.end();
    }
  }
  if (!ready) {
    child.kill();
    throw new Error(`开发数据库启动失败：${failure}`);
  }
  console.log(`开发数据库已启动：127.0.0.1:55432\n数据目录：${data}\nCtrl+C 停止。`);
  let stopping = false;
  const stopWindows = async () => {
    if (stopping) return;
    stopping = true;
    await runFile(resolve(runtime, 'bin/pg_ctl.exe'), ['-D', data, 'stop', '-m', 'fast'], {
      windowsHide: true,
    });
    process.exit(0);
  };
  process.on('SIGINT', stopWindows);
  process.on('SIGTERM', stopWindows);
}
