import type { Forge } from '@agentdock/shared/protocol';

/** `git@github.com:owner/name(.git)`, `ssh://git@github.com/owner/name`, `https://github.com/owner/name(.git)`. */
const GITHUB_REMOTE =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/** A GitHub repository named in prose: `github.com/owner/name`, with or without scheme. */
const GITHUB_MENTION =
  /github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=$|[/#?])/;

export interface ParsedRemote {
  forge: Forge;
  repo: string | null;
}

/** D3: an `origin` on github.com is `owner/name`; any other host is unsupported. */
export const parseRemote = (url: string): ParsedRemote => {
  const match = url.trim().match(GITHUB_REMOTE);
  return match
    ? { forge: 'github', repo: `${match[1]}/${match[2]}` }
    : { forge: 'unsupported', repo: null };
};

/** `owner/name` of a GitHub URL found in text, or null. */
export const githubRepoIn = (text: string): string | null => {
  const match = text.match(GITHUB_MENTION);
  return match ? `${match[1]}/${match[2]}` : null;
};

export const ownerOf = (repo: string): string => repo.split('/')[0];
export const nameOf = (repo: string): string => repo.split('/')[1];
