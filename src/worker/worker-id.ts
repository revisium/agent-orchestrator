import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';

export function resolveWorkerId(override?: string, testDataDir?: string): string {
  if (override) return override;

  const dataDir = testDataDir ?? getConfig().dataDir;
  const idFile = join(dataDir, 'worker-id');

  if (existsSync(idFile)) {
    return readFileSync(idFile, 'utf8').trim();
  }

  const id = `worker-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  writeFileSync(idFile, id, 'utf8');
  return id;
}
