import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PlaybookError } from './errors.js';
import type { RoleCatalogRecord } from './catalog-loader.js';
import { resolvePathInside } from './source-resolver.js';

export type PromptSource = {
  prompt: string;
  sourceHash: string;
};

export function stripMarkdownFrontmatter(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') return source.trim();
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) return source.trim();
  return lines.slice(end + 1).join('\n').trim();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function composeRolePrompt(root: string, role: RoleCatalogRecord, required = true): PromptSource {
  const rolePath = resolvePathInside(root, role.path);
  if (!existsSync(rolePath)) {
    if (!required) return { prompt: '', sourceHash: '' };
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `Role source is missing: ${role.path}`);
  }

  const roleBody = stripMarkdownFrontmatter(readFileSync(rolePath, 'utf8'));
  const referencePath = join(rolePath, '..', 'references', 'core.md');
  const parts = [roleBody];
  if (existsSync(referencePath)) {
    parts.push(stripMarkdownFrontmatter(readFileSync(referencePath, 'utf8')));
  }
  const prompt = parts.filter((part) => part.trim() !== '').join('\n\n');
  return { prompt, sourceHash: sha256(prompt) };
}
