/**
 * Prepares the Docker Hub repositories a release mirrors its images to
 * (ADR-0097), before release-images.sh pushes:
 *
 *   - creates each missing repository as public (`POST /v2/repositories/`);
 *   - refuses a repository that exists but is private: nobody could pull it;
 *   - sets its one-line `description` and its `full_description`, README.md
 *     with relative links made absolute and a header naming the image
 *     (`PATCH /v2/repositories/<namespace>/<name>/`).
 *
 *   bun scripts/dockerhub.ts            # DOCKERHUB_USERNAME, DOCKERHUB_TOKEN
 *   bun scripts/dockerhub.ts --dry-run  # prints what it would send, no network
 *
 * The namespace and the repository prefix come from deploy/images/dockerhub.env,
 * and the environment variables of the same names win. The token is a Docker
 * Hub access token of DOCKERHUB_USERNAME. Any refused request exits 1.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const REPO = 'AndreyBegma/Nautelle';
const HUB = 'https://hub.docker.com';
/** Docker Hub's limits for the two descriptions. */
const SHORT_LIMIT = 100;
const FULL_LIMIT = 25_000;

export interface HubSettings {
  namespace: string;
  prefix: string;
}

export interface HubRepository {
  /** The repository name inside the namespace: `nautelle-api`. */
  name: string;
  /** The same image on ghcr.io: `ghcr.io/andreybegma/nautelle-api`. */
  ghcr: string;
  /** The one-line description. */
  description: string;
}

/** dockerhub.env's `KEY=value` lines, overridden by the environment. */
export const readSettings = (
  file: string,
  env: Record<string, string | undefined>,
): HubSettings => {
  const values = new Map<string, string>();
  for (const line of file.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1] as string, match[2] as string);
  }
  const pick = (key: string) => env[key] ?? values.get(key) ?? '';
  const namespace = pick('DOCKERHUB_NAMESPACE');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(namespace)) {
    throw new Error(`DOCKERHUB_NAMESPACE "${namespace}" is not a namespace`);
  }
  return { namespace, prefix: pick('DOCKERHUB_REPO_PREFIX') };
};

export const repositories = ({ prefix }: HubSettings): HubRepository[] => [
  {
    name: `${prefix}api`,
    ghcr: 'ghcr.io/andreybegma/nautelle-api',
    description:
      'Nautelle API: self-hosted control plane for Claude Code and Codex agent fleets.',
  },
  {
    name: `${prefix}web`,
    ghcr: 'ghcr.io/andreybegma/nautelle-web',
    description:
      'Nautelle web app: self-hosted control plane for Claude Code and Codex agent fleets.',
  },
  {
    name: 'nautelle',
    ghcr: 'ghcr.io/andreybegma/nautelle',
    description:
      'Nautelle in one container (API, web, Caddy; demo PostgreSQL and Redis inside).',
  },
];

/** README.md with every relative link and image made absolute to `main`. */
export const absoluteLinks = (readme: string): string => {
  const relative = (target: string) =>
    !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
  const blob = (target: string) =>
    `https://github.com/${REPO}/blob/main/${target.replace(/^\.\//, '')}`;
  const raw = (target: string) =>
    `https://raw.githubusercontent.com/${REPO}/main/${target.replace(/^\.\//, '')}`;
  return readme
    .replace(
      /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g,
      (match, image: string, text: string, target: string) =>
        relative(target)
          ? `${image}[${text}](${image ? raw(target) : blob(target)})`
          : match,
    )
    .replace(/\b(src|srcset)="([^"]+)"/g, (match, attribute: string, target) =>
      relative(target) ? `${attribute}="${raw(target)}"` : match,
    )
    .replace(/\bhref="([^"]+)"/g, (match, target: string) =>
      relative(target) ? `href="${blob(target)}"` : match,
    );
};

export const fullDescription = (
  readme: string,
  repository: HubRepository,
  settings: HubSettings,
): string => {
  const image = `docker.io/${settings.namespace}/${repository.name}`;
  const header = [
    `> **${image}** is the same image as \`${repository.ghcr}\`, with the same digests, tags (\`X.Y.Z\`, \`X.Y\`, \`X\`, \`latest\`) and cosign signature:`,
    '> `cosign verify --key https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/images/cosign.pub ' +
      `${image}:X.Y.Z\`.`,
    ...(repository.name === 'nautelle'
      ? [
          '>',
          `> Try it: \`docker run -p 8000:8000 -v nautelle:/data ${settings.namespace}/nautelle\`, then open the setup link it prints. Without \`DATABASE_URL\` and \`REDIS_URL\` it runs a demo PostgreSQL and Redis inside: not for production.`,
        ]
      : []),
    '',
    '',
  ].join('\n');
  const body = absoluteLinks(readme);
  const text = header + body;
  if (text.length <= FULL_LIMIT) return text;
  const more = `\n\n… the rest is in [README.md](https://github.com/${REPO}#readme).\n`;
  return text.slice(0, FULL_LIMIT - more.length) + more;
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SyncOptions {
  settings: HubSettings;
  readme: string;
  username: string;
  token: string;
  fetch: Fetch;
  log: (line: string) => void;
}

const request = async (
  fetch: Fetch,
  method: string,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<Response> => {
  const response = await fetch(`${HUB}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
};

const refused = async (response: Response, what: string): Promise<Error> =>
  new Error(
    `${what}: Docker Hub answered ${response.status} ${(await response.text()).slice(0, 300)}`,
  );

/** Creates the missing repositories and sets every description. */
export const syncRepositories = async ({
  settings,
  readme,
  username,
  token,
  fetch,
  log,
}: SyncOptions): Promise<void> => {
  const login = await request(fetch, 'POST', '/v2/auth/token', {
    identifier: username,
    secret: token,
  });
  if (!login.ok) throw await refused(login, `signing in as ${username}`);
  const { access_token: bearer } = (await login.json()) as {
    access_token?: string;
  };
  if (!bearer) throw new Error('signing in: Docker Hub returned no token');

  for (const repository of repositories(settings)) {
    const path = `/v2/repositories/${settings.namespace}/${repository.name}/`;
    const label = `${settings.namespace}/${repository.name}`;
    const descriptions = {
      description: repository.description.slice(0, SHORT_LIMIT),
      full_description: fullDescription(readme, repository, settings),
    };
    const existing = await request(fetch, 'GET', path, undefined, bearer);
    if (existing.status === 404) {
      const created = await request(
        fetch,
        'POST',
        '/v2/repositories/',
        {
          namespace: settings.namespace,
          name: repository.name,
          is_private: false,
          ...descriptions,
        },
        bearer,
      );
      if (!created.ok) throw await refused(created, `creating ${label}`);
      log(`created ${label} (public)`);
    } else if (!existing.ok) {
      throw await refused(existing, `reading ${label}`);
    } else if (
      ((await existing.json()) as { is_private?: boolean }).is_private
    ) {
      throw new Error(
        `${label} is private: make it public on Docker Hub, or nobody can pull the mirror`,
      );
    }
    const updated = await request(fetch, 'PATCH', path, descriptions, bearer);
    if (!updated.ok) throw await refused(updated, `describing ${label}`);
    log(`described ${label}`);
  }
};

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const settings = readSettings(
      readFileSync(join(root, 'deploy/images/dockerhub.env'), 'utf8'),
      process.env,
    );
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    if (dryRun) {
      for (const repository of repositories(settings)) {
        const full = fullDescription(readme, repository, settings);
        console.log(
          `would create or describe docker.io/${settings.namespace}/${repository.name}: "${repository.description}", ${full.length} characters of README`,
        );
      }
    } else {
      const username = process.env.DOCKERHUB_USERNAME ?? '';
      const token = process.env.DOCKERHUB_TOKEN ?? '';
      if (username === '' || token === '') {
        throw new Error(
          'DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are needed (the dockerhub_* secrets, tag event only)',
        );
      }
      await syncRepositories({
        settings,
        readme,
        username,
        token,
        fetch,
        log: (line) => console.log(`dockerhub: ${line}`),
      });
    }
  } catch (error) {
    console.error(`dockerhub: ${(error as Error).message}`);
    process.exit(1);
  }
}
