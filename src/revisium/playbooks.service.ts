import { Injectable } from '@nestjs/common';
import { createVersionedMeaningAccess } from '../control-plane/versioned-meaning.js';
import { PlaybookInstaller, type PlaybookInstallOptions, type PlaybookInstallResult } from '../playbook/playbook-installer.js';

@Injectable()
export class PlaybooksService {
  install(options: PlaybookInstallOptions): Promise<PlaybookInstallResult> {
    const installer = new PlaybookInstaller({
      access: createVersionedMeaningAccess({ dryRun: options.dryRun }),
    });
    return installer.install(options);
  }
}
