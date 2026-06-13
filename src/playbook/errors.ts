export type PlaybookErrorCode =
  | 'PLAYBOOK_SOURCE_NOT_FOUND'
  | 'PLAYBOOK_SOURCE_NOT_IMPLEMENTED'
  | 'PLAYBOOK_INVALID_MANIFEST'
  | 'PLAYBOOK_UNSUPPORTED_SCHEMA'
  | 'PLAYBOOK_INVALID_CATALOG'
  | 'PLAYBOOK_INVALID_PATH'
  | 'PLAYBOOK_INSTALL_FAILED';

export class PlaybookError extends Error {
  constructor(
    readonly code: PlaybookErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlaybookError';
  }
}

export function isPlaybookError(error: unknown): error is PlaybookError {
  return error instanceof PlaybookError;
}
