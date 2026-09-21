import { copyFile, cp } from 'node:fs/promises';
await copyFile(
  new URL('../server/schema.sql', import.meta.url),
  new URL('../dist/server/schema.sql', import.meta.url),
);
await cp(
  new URL('../server/migrations/', import.meta.url),
  new URL('../dist/server/migrations/', import.meta.url),
  { recursive: true },
);
