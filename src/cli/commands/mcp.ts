import { Command } from 'commander';
import type { INestApplicationContext } from '@nestjs/common';
import { McpStdioService } from '../../mcp/mcp-stdio.service.js';

async function startMcp(app: INestApplicationContext | undefined): Promise<void> {
  if (!app) {
    console.error('mcp requires the host context — invoke via the host path');
    process.exitCode = 1;
    return;
  }
  await app.get(McpStdioService).start();
}

export function registerMcp(program: Command, app?: INestApplicationContext): void {
  program
    .command('mcp')
    .description('Start the local stdio MCP server for task development control')
    .action(() => startMcp(app));
}
