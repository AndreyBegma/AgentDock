import type { Exec, ExecResult } from '../detect/exec';
import { skillsWorkspace, withFakeGh } from '../skills/testing';

/**
 * The skills workspace (real git, a bare origin, project `widget` on GitHub's
 * `acme/widget`) with a `gh` that also answers `pr list --head`: the PRs
 * `pr create` opened so far, all open, so a second collect finds the first
 * PR instead of opening another.
 */
export const cardsWorkspace = async () => {
  const f = await skillsWorkspace();
  const gh = withFakeGh(f.git, f.root);
  const open: {
    number: number;
    url: string;
    head: string;
    isDraft?: boolean;
  }[] = [];
  const listCalls: string[][] = [];
  const exec: Exec = async (binary, args, options) => {
    if (binary === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      listCalls.push([...args]);
      const head = args[args.indexOf('--head') + 1];
      const found = open
        .filter((pr) => pr.head === head)
        .map(({ number, url, isDraft }) => ({
          number,
          url,
          isDraft: isDraft ?? false,
        }));
      const ok: ExecResult = {
        code: 0,
        stdout: JSON.stringify(found),
        stderr: '',
      };
      return ok;
    }
    const result = await gh.exec(binary, args, options);
    if (
      binary === 'gh' &&
      args[0] === 'pr' &&
      args[1] === 'create' &&
      result?.code === 0
    ) {
      const head = args[args.indexOf('--head') + 1] ?? '';
      open.push({ number: 7, url: result.stdout.trim(), head });
    }
    return result;
  };
  const prCreates = () =>
    gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  return { ...f, exec, gh, open, listCalls, prCreates };
};
