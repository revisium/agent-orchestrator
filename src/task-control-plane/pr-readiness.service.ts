import { Injectable } from '@nestjs/common';
import {
  collectPrReadiness,
  type PrReadinessInput,
  type PrReadinessResult,
} from '../poller/pr-readiness-core.js';

export type GetPrReadinessInput = {
  repo: string;
  prNumber?: number;
  headBranch?: string;
  baseBranch?: string;
  sonarProject?: string;
  includeComments?: boolean;
  includeReviewThreads?: boolean;
};

export type PrFeedbackQueue = Pick<
  PrReadinessResult['feedback'],
  | 'developerFixes'
  | 'reviewerQuestions'
  | 'providerWait'
  | 'humanDecisions'
  | 'ignoredNoise'
  | 'residualRisks'
>;

@Injectable()
export class PrReadinessService {
  getPrReadiness(input: GetPrReadinessInput): Promise<PrReadinessResult> {
    return collectPrReadiness(this.toCoreInput(input));
  }

  async listPrFeedback(input: GetPrReadinessInput): Promise<PrFeedbackQueue> {
    const readiness = await this.getPrReadiness(input);
    return readiness.feedback;
  }

  private toCoreInput(input: GetPrReadinessInput): PrReadinessInput {
    return {
      repo: input.repo,
      prNumber: input.prNumber,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch ?? 'master',
      sonarProject: input.sonarProject,
      includeComments: input.includeComments ?? true,
      includeReviewThreads: input.includeReviewThreads ?? true,
    };
  }
}
