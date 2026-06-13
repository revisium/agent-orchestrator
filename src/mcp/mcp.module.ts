import { Module } from '@nestjs/common';
import { TaskControlPlaneModule } from '../task-control-plane/task-control-plane.module.js';
import { McpFacadeService } from './mcp-facade.service.js';
import { McpStdioService } from './mcp-stdio.service.js';

@Module({
  imports: [TaskControlPlaneModule],
  providers: [McpFacadeService, McpStdioService],
  exports: [McpFacadeService, McpStdioService],
})
export class McpModule {}
