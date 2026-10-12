import { Module } from '@nestjs/common';
import { CryptoModule } from '../common/crypto';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { CollectorPollSender } from './collector-poll-sender';
import {
  GitHubAppAdminController,
  GitHubHookController,
  ProjectGitHubAppController,
} from './github-app.controller';
import {
  GITHUB_APP_OPTIONS,
  githubAppOptionsFromEnv,
} from './github-app-options';
import { GitHubAppStore } from './github-app-store';
import { GitHubAppClient } from './github-client';
import { GitHubHealthService } from './github-health.service';
import { GitHubHookService } from './github-hook.service';
import { GitHubInstallationsService } from './github-installations.service';
import { GitHubRegistrationService } from './github-registration.service';
import { GitHubRetentionJob } from './github-retention.job';

/**
 * The instance's read-only GitHub App (docs/specs/27-github-app.md): turns
 * GitHub's deliveries into immediate polls on the project's runner, whose
 * collectors stay the only writers of fleet and queue state. Nothing here
 * writes to GitHub (ADR-0004) or reads a project's files (ADR-0001).
 */
@Module({
  imports: [CryptoModule, RunnersModule, ProjectsModule],
  controllers: [
    GitHubHookController,
    GitHubAppAdminController,
    ProjectGitHubAppController,
  ],
  providers: [
    {
      provide: GITHUB_APP_OPTIONS,
      useFactory: () => githubAppOptionsFromEnv(),
    },
    CollectorPollSender,
    GitHubAppClient,
    GitHubAppStore,
    GitHubHealthService,
    GitHubHookService,
    GitHubInstallationsService,
    GitHubRegistrationService,
    GitHubRetentionJob,
  ],
})
export class GitHubAppModule {}
