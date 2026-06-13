import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readPackageVersion } from '../package-info.js';
import { MCP_INSTRUCTIONS } from './mcp-capabilities.js';
import { McpFacadeService } from './mcp-facade.service.js';
import { registerRevoMcpTools } from './mcp-tools.js';

@Injectable()
export class McpStdioService {
  constructor(private readonly facade: McpFacadeService) {}

  async start(): Promise<void> {
    const server = new McpServer(
      { name: 'revo', version: readPackageVersion() },
      { instructions: MCP_INSTRUCTIONS },
    );
    registerRevoMcpTools(server, this.facade);

    const transport = new StdioServerTransport();
    const closed = new Promise<void>((resolve, reject) => {
      transport.onclose = () => resolve();
      transport.onerror = (error) => reject(error);
      process.stdin.once('end', resolve);
      process.stdin.once('close', resolve);
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });

    await server.connect(transport);
    try {
      await closed;
    } finally {
      await server.close().catch(() => undefined);
    }
  }
}
