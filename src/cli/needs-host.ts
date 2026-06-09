/**
 * needsHost() — pure argv pre-parse (no Nest/DBOS import).
 *
 * Returns true ONLY for host-requiring commands:
 *   - dev:ping, dev:status (slice 0001)
 *   - run start (slice 0003 — enqueues a DBOS workflow, needs the host)
 *   - run create --start (slice 0006 — enqueues immediately after create, needs the host)
 *   - inbox resolve --approve|--reject (slice 0004 — signals a parked workflow, needs DBOS)
 *
 * All other run subcommands (create/list/show/events/cancel) remain host-free.
 * `run create` WITHOUT --start stays host-free.
 * inbox list/show and inbox resolve --answer (non-gate) remain host-free.
 *
 * Design rules:
 *   - Help/version flags anywhere → always host-free (consensus MINOR, codex round 2).
 *   - Default is host-free (allowlist miss → false); fail-safe for unknown commands.
 *   - No Nest, DBOS, or AppModule imports here (F1 — keep the host-free path lightweight).
 *   - `inbox resolve` is classified host-requiring ONLY when --approve or --reject is present
 *     in argv (pure argv-parse; cannot read the row here). Non-gate `--answer` stays host-free.
 *   - `run create --start` is host-requiring because it enqueues a DBOS workflow immediately.
 *
 * M5 (TASK 0003): subcommand-aware `run start` routing.
 * G4/G6 (TASK 0004): subcommand-aware `inbox resolve --approve|--reject` routing.
 * 0006: `run create --start` → host-requiring.
 */

/** Commands that require the Nest/DBOS host context (colon-style, no subcommand needed). */
const HOST_COMMANDS = new Set(['dev:ping', 'dev:status']);

/** Flags that force host-free regardless of the command. */
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-v']);

/** Gate-resolve flags that make `inbox resolve` host-requiring (0004). */
const GATE_FLAGS = new Set(['--approve', '--reject']);

/**
 * Decide whether an argv array needs the Nest host context.
 * @param argv - process.argv-style array (first two elements are node + script).
 */
export function needsHost(argv: string[]): boolean {
  const args = argv.slice(2); // strip node + script

  // Any help/version flag anywhere → host-free.
  if (args.some((a) => HELP_FLAGS.has(a))) return false;

  // Find the first non-flag argument (the command name).
  const command = args.find((a) => !a.startsWith('-'));
  if (!command) return false;

  // M5: `run start` is host-requiring; all other `run` subcommands are host-free.
  // 0006: `run create --start` is host-requiring (it enqueues a DBOS workflow).
  if (command === 'run') {
    const commandIdx = args.indexOf(command);
    const sub = args.slice(commandIdx + 1).find((a) => !a.startsWith('-'));
    if (sub === 'start') return true;
    if (sub === 'create') return args.includes('--start');
    return false;
  }

  // G4/G6: `inbox resolve --approve|--reject` is host-requiring (gate path — signals DBOS).
  // `inbox list`/`show` and `inbox resolve --answer` (non-gate) stay host-free.
  if (command === 'inbox') {
    const commandIdx = args.indexOf(command);
    const sub = args.slice(commandIdx + 1).find((a) => !a.startsWith('-'));
    if (sub === 'resolve') {
      return args.some((a) => GATE_FLAGS.has(a));
    }
    return false;
  }

  return HOST_COMMANDS.has(command);
}
