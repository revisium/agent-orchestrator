import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/dbos.module.js';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { McpFacadeService } from './mcp-facade.service.js';
import { McpStdioService } from './mcp-stdio.service.js';

@Module({
  imports: [EngineModule, RevisiumModule, PipelineModule],
  providers: [McpFacadeService, McpStdioService],
  exports: [McpFacadeService, McpStdioService],
})
export class McpModule {}
