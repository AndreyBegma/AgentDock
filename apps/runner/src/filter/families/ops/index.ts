import type { Filter } from '../../types';
import { awsFilter, gcloudFilter } from './cloud';
import { curlFilter } from './curl';
import { dockerFilter } from './docker';
import { ghFilter, glabFilter } from './forge';
import { gitFilter } from './git';
import { helmFilter, kubectlFilter } from './kube';
import { makeFilter } from './make';
import { terraformFilter } from './terraform';

/**
 * VCS, CI and ops: git, gh, glab, docker / compose, kubectl, helm, terraform,
 * aws, gcloud, make, curl. Each filter shortens the progress and listing noise
 * of its command, never structured (JSON / YAML) output, and keeps every
 * error, warning and failure line. Cases live in `./corpus`.
 */
export const opsFilters: readonly Filter[] = [
  gitFilter,
  ghFilter,
  glabFilter,
  dockerFilter,
  kubectlFilter,
  helmFilter,
  terraformFilter,
  awsFilter,
  gcloudFilter,
  makeFilter,
  curlFilter,
];
