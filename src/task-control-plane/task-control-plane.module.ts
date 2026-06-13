import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/dbos.module.js';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { TaskControlPlaneApiService } from './task-control-plane-api.service.js';

@Module({
  imports: [EngineModule, RevisiumModule, PipelineModule],
  providers: [TaskControlPlaneApiService],
  exports: [TaskControlPlaneApiService],
})
export class TaskControlPlaneModule {}
