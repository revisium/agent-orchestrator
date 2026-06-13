import { readFileSync } from 'node:fs';

export function readPackageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json is missing a "version" field');
  }
  return pkg.version;
}
