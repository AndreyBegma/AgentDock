/** A project the person can access, as the resolver matches it. */
export interface ResolvableProject {
  id: string;
  displayName: string;
  /** `owner/name`. */
  repo: string;
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The names a person might call a project by: its display name and repo. */
const namesOf = (project: ResolvableProject): string[] => {
  const repo = project.repo.toLowerCase();
  const name = repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : '';
  return [project.displayName.toLowerCase(), repo, name].filter(
    (n) => n.trim().length >= 2,
  );
};

const mentions = (message: string, name: string): boolean =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_.-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`,
    'iu',
  ).test(message);

/** The first word of a multi-word name, e.g. `billing` of `billing-api`. */
const leadOf = (name: string): string | null => {
  const [lead, ...rest] = name.split(/[\s/_-]+/);
  return rest.length > 0 && lead.length >= 4 ? lead : null;
};

/**
 * ADR-0060 §3, Auto: the accessible projects the message names, by display
 * name, `owner/name` or the repository name, as whole words. Without a full
 * name, the first word of one (`billing` of `billing-api`) counts, so a
 * message that could mean several projects names them all.
 */
export const projectsNamedIn = <P extends ResolvableProject>(
  message: string,
  projects: readonly P[],
): P[] => {
  const named = projects.filter((project) =>
    namesOf(project).some((name) => mentions(message, name)),
  );
  if (named.length > 0) return named;
  return projects.filter((project) =>
    namesOf(project).some((name) => {
      const lead = leadOf(name.slice(name.lastIndexOf('/') + 1));
      return lead !== null && mentions(message, lead);
    }),
  );
};
