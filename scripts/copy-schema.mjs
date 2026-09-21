import { copyFile } from 'node:fs/promises';
await copyFile(
  new URL('../server/schema.sql', import.meta.url),
  new URL('../dist/server/schema.sql', import.meta.url),
);
