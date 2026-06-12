/**
 * gh-identity.ts — pin the gh CLI to an explicit, NON-SECRET account name (0008 #1).
 *
 * Proven failure (2026-06-10 live dogfood): the integrator shelled `gh pr create` using the
 * AMBIENT active gh account. On a multi-account machine the active account flips
 * (anton62k push:false ↔ revisium-io push:true), so PR creation failed and the workflow
 * went silently to DBOS ERROR. The fix: resolve a non-secret identity NAME (default
 * `revisium-io`) → host-resolve its token (env/keyring) → spawn gh with `GH_TOKEN` pinned.
 * `GH_TOKEN` takes precedence over gh's active account, so the flip can no longer break us.
 *
 * SECRET BOUNDARY: only the non-secret account NAME is config (env `REVO_GH_ACCOUNT`).
 * The token is resolved host-side at call time and lives only in the spawned gh process env —
 * NEVER persisted to Revisium, never logged. Least-privilege: only the integrator builds a
 * pinned execGh; the LLM runners get no git/gh creds.
 *
 * DBOS-SEALED: zero @dbos-inc imports.
 */
import { execFileSync } from 'node:child_process';
import type { ExecGhFn } from '../poller/pr-readiness.js';

/** Default non-secret gh account identity (push:true/admin on the org repos). */
export const DEFAULT_GH_ACCOUNT = 'revisium-io';

/** Injectable execFile seam (tests pass a fake; production spawns gh synchronously). */
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { encoding: 'utf8'; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => string;

const defaultExecFile: ExecFileFn = (file, args, opts) => execFileSync(file, args, opts);

/**
 * Resolve the NON-SECRET gh account name from config/env. Never a token.
 * Falls back to DEFAULT_GH_ACCOUNT when unset/blank.
 */
export function resolveGhAccount(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['REVO_GH_ACCOUNT'];
  const account = typeof raw === 'string' ? raw.trim() : '';
  return account.length > 0 ? account : DEFAULT_GH_ACCOUNT;
}

/** Per-account env override key, e.g. account "revisium-io" → "GH_TOKEN_REVISIUM_IO". */
export function ghTokenEnvKey(account: string): string {
  return `GH_TOKEN_${account.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Host-resolve the gh token for a non-secret account name (never stored in Revisium):
 *   1. explicit env override GH_TOKEN_<ACCOUNT> (CI / headless) — takes precedence.
 *   2. the gh keyring entry for that specific account (`gh auth token --user <account>`).
 * Returns undefined when no token can be resolved (caller falls back to ambient gh).
 */
export function resolveGhToken(
  account: string,
  deps?: { env?: NodeJS.ProcessEnv; execFile?: ExecFileFn },
): string | undefined {
  const env = deps?.env ?? process.env;
  const execFile = deps?.execFile ?? defaultExecFile;

  const override = env[ghTokenEnvKey(account)];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();

  try {
    const out = execFile('gh', ['auth', 'token', '--user', account], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    // gh missing / account not in keyring — fall back to ambient gh (returns undefined).
    return undefined;
  }
}

/**
 * Build an ExecGhFn that PINS the gh account by setting GH_TOKEN on the spawned gh process.
 * When `token` is undefined the gh call is left on the ambient account (degraded — logged once
 * by the caller). The OS-level timeout + maxBuffer mirror defaultExecGh (a hung/runaway gh is
 * killed; the synchronous spawn blocks the event loop so no JS timer could otherwise fire).
 */
export function makeExecGh(opts?: {
  token?: string;
  execFile?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}): ExecGhFn {
  const execFile = opts?.execFile ?? defaultExecFile;
  const baseEnv = opts?.env ?? process.env;
  const timeout = opts?.timeoutMs ?? 60_000;
  const maxBuffer = opts?.maxBuffer ?? 10 * 1024 * 1024;
  const env = opts?.token ? { ...baseEnv, GH_TOKEN: opts.token } : baseEnv;
  return (args: string[]) => execFile('gh', args, { encoding: 'utf8', timeout, maxBuffer, env });
}

const TOKEN_PATTERN = /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/**
 * Mask GitHub token shapes in a free-text string (gho_/ghp_/ghs_/ghr_/ghu_ + github_pat_).
 * redactSecrets (inbox.ts) only masks secret-shaped object KEYS; an error/lesson string that
 * happens to echo a token needs this string-level pass before it is persisted to Revisium.
 */
export function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, '[REDACTED]');
}
