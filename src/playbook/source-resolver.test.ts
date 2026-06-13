import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePlaybookSource } from './source-resolver.js';
import { PlaybookError } from './errors.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'revo-playbook-source-'));
}

test('resolvePlaybookSource: resolves a local checkout path with package metadata', () => {
  const root = tempRoot();
  const playbookRoot = join(root, 'agents');
  mkdirSync(playbookRoot);
  writeFileSync(join(playbookRoot, 'package.json'), JSON.stringify({ name: '@x/playbook', version: '1.2.3' }));

  const source = resolvePlaybookSource('./agents', { cwd: root });

  assert.equal(source.type, 'local');
  assert.equal(source.root, playbookRoot);
  assert.equal(source.source, 'local:@x/playbook@1.2.3');
  assert.equal(source.packageName, '@x/playbook');
  assert.equal(source.version, '1.2.3');
});

test('resolvePlaybookSource: existing bare directory name wins over package resolution', () => {
  const root = tempRoot();
  const playbookRoot = join(root, 'agents');
  mkdirSync(playbookRoot);
  writeFileSync(join(playbookRoot, 'package.json'), JSON.stringify({ name: '@x/local', version: '1.0.0' }));

  const source = resolvePlaybookSource('agents', {
    cwd: root,
    packageRootResolver: () => {
      throw new Error('package resolver should not be called');
    },
  });

  assert.equal(source.type, 'local');
  assert.equal(source.source, 'local:@x/local@1.0.0');
  assert.equal(source.packageName, '@x/local');
});

test('resolvePlaybookSource: resolves an already-installed package through injected resolver', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@x/playbook', version: '2.0.0' }));

  const source = resolvePlaybookSource('@x/playbook', {
    packageRootResolver: () => root,
  });

  assert.equal(source.type, 'package');
  assert.equal(source.source, 'npm:@x/playbook@2.0.0');
});

test('resolvePlaybookSource: rejects remote repository shorthand in this slice', () => {
  assert.throws(
    () => resolvePlaybookSource('revisium/agent-playbook'),
    (err: unknown) => err instanceof PlaybookError && err.code === 'PLAYBOOK_SOURCE_NOT_IMPLEMENTED',
  );
});
