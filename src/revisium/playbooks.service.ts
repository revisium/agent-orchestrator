import { Inject, Injectable } from '@nestjs/common';
import type { ControlPlaneTransport } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { createVersionedMeaningAccess } from '../control-plane/versioned-meaning.js';
import { PlaybookInstaller, type PlaybookInstallOptions, type PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';

export type PlaybookSummary = {
  id: string;
  name: string;
  packageName: string;
  version: string;
  source: string;
};

export type PipelineSummary = {
  id: string;
  playbookId: string;
  pipelineId: string;
  path: string;
  requiredRoles: string[];
  optionalRoles: string[];
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter((item) => item.length > 0);
}

@Injectable()
export class PlaybooksService {
  constructor(
    @Inject(REVISIUM_TRANSPORT_HEAD) private readonly head: ControlPlaneTransport,
  ) {}

  install(options: PlaybookInstallOptions): Promise<PlaybookInstallResult> {
    const installer = new PlaybookInstaller({
      access: createVersionedMeaningAccess({ dryRun: options.dryRun }),
    });
    return installer.install(options);
  }

  async listPlaybooks(): Promise<PlaybookSummary[]> {
    const rows = await this.head.listRows('playbooks', { first: 100 });
    return (rows.edges ?? []).flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
      const data = node.data ?? {};
      return [{
        id: node.id,
        name: str(data.name),
        packageName: str(data.package_name),
        version: str(data.version),
        source: str(data.source),
      }];
    });
  }

  async listPipelines(): Promise<PipelineSummary[]> {
    const rows = await this.head.listRows('pipelines', { first: 500 });
    return (rows.edges ?? []).flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
      const data = node.data ?? {};
      return [{
        id: node.id,
        playbookId: str(data.playbook_id),
        pipelineId: str(data.pipeline_id) || node.id,
        path: str(data.path),
        requiredRoles: strArr(data.required_roles),
        optionalRoles: strArr(data.optional_roles),
      }];
    });
  }

  async getPipeline(id: string): Promise<PipelineSummary | null> {
    let row;
    try {
      row = await this.head.getRow('pipelines', id);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') return null;
      throw error;
    }
    if (!row) return null;
    const data = row.data ?? {};
    return {
      id: row.id,
      playbookId: str(data.playbook_id),
      pipelineId: str(data.pipeline_id) || row.id,
      path: str(data.path),
      requiredRoles: strArr(data.required_roles),
      optionalRoles: strArr(data.optional_roles),
    };
  }
}
