import type { Role } from '@nautelle/shared';
import type {
  LocalMethodArgs,
  LocalMethodName,
  LocalMethodResult,
  LocalRequestMessage,
} from '@nautelle/shared/protocol';
import type { AuditContext } from '../audit/audit.types';
import { LocalError } from './local-error';

/** The project a local request is about, as the router verified it. */
export interface LocalProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
  displayName: string;
  baseBranch: string;
  baseOverride: string | null;
}

/** One authorized local request, as the handlers receive it (D8). */
export interface LocalCall {
  runnerId: string;
  requestId: string;
  /** The runner's local user — whom the request acts for. */
  user: { id: string; email: string; role: Role };
  /** `min(role on the project, operator)`; the global role, capped, without one. */
  role: Role;
  project: LocalProject | null;
  /** The plugin session that asked, when the daemon could tell (D10). */
  session: { runtime: string; id: string } | null;
  via: LocalRequestMessage['via'];
  /** Actor `runner{runnerId}`. */
  ctx: AuditContext;
  /** `meta` of every audit record the request writes. */
  meta: { onBehalfOf: string; via: LocalRequestMessage['via'] };
}

export type LocalHandler<N extends LocalMethodName> = (
  args: LocalMethodArgs<N>,
  call: LocalCall,
) => Promise<LocalMethodResult<N>>;

/** One handler per method of the allowlist; the compiler checks none is missing. */
export type LocalHandlerTable = { [N in LocalMethodName]: LocalHandler<N> };

/** The verified project; the router never calls a project method without one. */
export const projectOf = (call: LocalCall): LocalProject => {
  if (!call.project) throw new LocalError('no_project', 'no project');
  return call.project;
};
