import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  type GitHubAppView,
  type GitHubManifestResponse,
} from '@nautelle/shared';
import { Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { SecretCipher } from '../common/crypto';
import { RunnerIngestService } from '../runners/runner-ingest.service';
import { RunnerWatchList } from '../runners/runner-watch-list';
import { createUser, login, type Session } from '../test/e2e-app';
import { HookFailureThrottle } from '../webhooks/common';
import { CollectorPollSender } from './collector-poll-sender';
import { GitHubHookController } from './github-app.controller';
import { GitHubHealthService } from './github-health.service';
import { GitHubHookService } from './github-hook.service';
import { GitHubRetentionJob } from './github-retention.job';
import { signGitHubDelivery } from './github-signature';
import {
  SIGNATURE_FAILURE_THRESHOLD,
  SignatureFailureTracker,
} from './signature-failure-tracker';
import {
  APP_ID,
  APP_PEM,
  CLIENT_SECRET,
  createGitHubApp,
  deliver,
  eventually,
  type GitHubE2e,
  MANIFEST_CODE,
  resetGitHub,
  SLUG,
  seedRepoProject,
  testCipher,
  WEBHOOK_SECRET,
} from './testing/github-app-e2e';

const ADMIN_ROUTE = '/admin/github-app';
const REPO = 'AndreyBegma/AgentDock';
const SECRETS = [APP_PEM, WEBHOOK_SECRET, CLIENT_SECRET];
/** A line of the PEM body: present in any echo of the key, whatever its wrapping. */
const PEM_LINE = APP_PEM.split('\n')[5];

const issuesLabeled = (fullName = REPO, installationId = 77) => ({
  action: 'labeled',
  issue: { number: 27, state: 'open' },
  repository: { full_name: fullName },
  installation: { id: installationId },
  sender: { login: 'archi' },
});

describe('GitHub App (e2e, spec 27)', () => {
  let ctx: GitHubE2e;
  let admin: Session;
  let adminId: string;
  let logged: string[];
  let auditFrom: bigint;

  beforeAll(async () => {
    ctx = await createGitHubApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetGitHub(ctx.prisma);
    ctx.github.installations = [];
    ctx.github.hookDeliveryStatus = 200;
    ctx.github.calls = [];
    ctx.sender.sent = [];
    ctx.sender.delayMs = 0;
    ctx.app.get(GitHubHookService).debouncer.clear();
    ctx.app.get(SignatureFailureTracker).reset();
    new HookFailureThrottle().reset();
    adminId = (await createUser(ctx.prisma, 'ada@example.com', 'admin')).id;
    admin = await login(ctx, 'ada@example.com');
    auditFrom =
      (
        await ctx.prisma.auditRecord.findFirst({
          orderBy: { seq: 'desc' },
          select: { seq: true },
        })
      )?.seq ?? 0n;
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  /** The manifest flow, end to end; answers the callback's redirect. */
  const register = async (session = admin) => {
    const manifest = await session.send('post', `${ADMIN_ROUTE}/manifest`, {});
    expect(manifest.status).toBe(200);
    const { state } = manifest.body as GitHubManifestResponse;
    return session.get(
      `${ADMIN_ROUTE}/callback?code=${MANIFEST_CODE}&state=${encodeURIComponent(state)}`,
    );
  };

  /** Registered, with installation 77 listing `repos`, synced. */
  const registerWith = async (repos: string[] = [REPO]) => {
    ctx.github.installations = [
      {
        id: 77,
        login: 'AndreyBegma',
        repos: repos.map((fullName, i) => ({ id: 1000 + i, fullName })),
      },
    ];
    expect((await register()).status).toBe(302);
    expect((await admin.send('post', `${ADMIN_ROUTE}/resync`)).status).toBe(
      200,
    );
  };

  /** This test's records: the audit chain is never truncated. */
  const auditOf = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { action, seq: { gt: auditFrom } },
      orderBy: { seq: 'asc' },
    });

  const json = (value: unknown) =>
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );

  const expectNoSecret = (text: string) => {
    for (const secret of [...SECRETS, PEM_LINE])
      expect(text).not.toContain(secret);
  };

  describe('manifest (D1, D2, D14)', () => {
    it('carries exactly the D2 permissions and events, the hook URL and the redirect URL', async () => {
      const res = await admin.send('post', `${ADMIN_ROUTE}/manifest`, {
        owner: 'my-org',
      });
      expect(res.status).toBe(200);
      const body = res.body as GitHubManifestResponse;
      expect(body.postUrl).toBe(
        `https://github.com/organizations/my-org/settings/apps/new?state=${encodeURIComponent(body.state)}`,
      );
      expect(body.manifest.default_permissions).toEqual(GITHUB_APP_PERMISSIONS);
      expect(Object.values(body.manifest.default_permissions)).toEqual(
        Array(6).fill('read'),
      );
      expect(body.manifest.default_events).toEqual([...GITHUB_APP_EVENTS]);
      expect(body.manifest.hook_attributes).toEqual({
        url: 'https://dock.example/hooks/github',
        active: true,
      });
      expect(body.manifest.redirect_url).toBe(
        'http://web.test/admin/integrations/github/callback',
      );
      expect(body.manifest.public).toBe(false);
    });

    it('refuses an owner that is not a GitHub login', async () => {
      const res = await admin.send('post', `${ADMIN_ROUTE}/manifest`, {
        owner: '../x',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('callback and secrets (D1, D3, D16)', () => {
    it('exchanges the code, stores every secret as ciphertext, and shows none', async () => {
      const res = await register();
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        'http://web.test/admin/integrations/github?registered=1',
      );
      expect(ctx.github.calls).toContainEqual({
        method: 'POST',
        path: `/app-manifests/${MANIFEST_CODE}/conversions`,
        authorization: null,
      });

      const row = await ctx.prisma.gitHubApp.findUniqueOrThrow({
        where: { id: 'app' },
      });
      expect(row).toMatchObject({
        appId: APP_ID,
        slug: SLUG,
        hookActive: true,
        registeredById: adminId,
      });
      const cipher = testCipher();
      for (const [sealed, plain] of [
        [row.privateKey, APP_PEM],
        [row.webhookSecret, WEBHOOK_SECRET],
        [row.clientSecret ?? '', CLIENT_SECRET],
      ]) {
        expect(SecretCipher.isSealed(sealed)).toBe(true);
        expect(sealed).not.toContain(plain);
        expect(cipher.decrypt(sealed)).toBe(plain);
      }

      const view = await admin.get(ADMIN_ROUTE);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        registered: true,
        slug: SLUG,
        encryptionAvailable: true,
      });
      expectNoSecret(view.text);
      const audit = await auditOf('github_app.register');
      expect(audit).toHaveLength(1);
      expectNoSecret(json(audit[0]));
      // Background resync and health settle; nothing they log holds a secret.
      await ctx.app.get(GitHubHealthService).recompute();
      expectNoSecret(logged.join('\n'));
    });

    it('refuses an unknown or someone else’s state, and a code GitHub rejects', async () => {
      const unknown = await admin.get(
        `${ADMIN_ROUTE}/callback?code=${MANIFEST_CODE}&state=nope`,
      );
      expect(unknown.headers.location).toBe(
        'http://web.test/admin/integrations/github?error=invalid_state',
      );

      await createUser(ctx.prisma, 'bob@example.com', 'admin');
      const bob = await login(ctx, 'bob@example.com');
      const { state } = (
        await admin.send('post', `${ADMIN_ROUTE}/manifest`, {})
      ).body as GitHubManifestResponse;
      const stolen = await bob.get(
        `${ADMIN_ROUTE}/callback?code=${MANIFEST_CODE}&state=${state}`,
      );
      expect(stolen.headers.location).toContain('error=invalid_state');

      const bad = await admin.get(
        `${ADMIN_ROUTE}/callback?code=other&state=${state}`,
      );
      expect(bad.headers.location).toContain('error=invalid_credentials');
      expect(await ctx.prisma.gitHubApp.count()).toBe(0);
    });

    it('takes manual credentials, verified against GET /app, and audits a re-entry', async () => {
      const badKey = await admin.send('put', ADMIN_ROUTE, {
        appId: APP_ID,
        slug: SLUG,
        privateKey: 'not a pem',
        webhookSecret: WEBHOOK_SECRET,
      });
      expect(badKey.status).toBe(400);
      expect(badKey.body.error).toBe('invalid_credentials');

      const body = {
        appId: APP_ID,
        slug: SLUG,
        privateKey: APP_PEM,
        webhookSecret: WEBHOOK_SECRET,
      };
      const first = await admin.send('put', ADMIN_ROUTE, body);
      expect(first.status).toBe(200);
      expectNoSecret(first.text);
      const again = await admin.send('put', ADMIN_ROUTE, body);
      expect(again.status).toBe(200);
      expect(await auditOf('github_app.register')).toHaveLength(1);
      const updated = await auditOf('github_app.update_credentials');
      expect(updated).toHaveLength(1);
      expectNoSecret(json(updated[0]));
    });

    it('refuses to store anything without APP_ENCRYPTION_KEY (409)', async () => {
      const bare = await createGitHubApp(
        {},
        SecretCipher.fromKeyText(undefined),
      );
      try {
        await resetGitHub(bare.prisma);
        await createUser(bare.prisma, 'eve@example.com', 'admin');
        const eve = await login(bare, 'eve@example.com');
        // The admin page learns it up front, before trying to register.
        expect((await eve.get(ADMIN_ROUTE)).body).toEqual({
          registered: false,
          publicUrl: 'https://dock.example',
          encryptionAvailable: false,
        });
        const res = await eve.send('post', `${ADMIN_ROUTE}/manifest`, {});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('encryption_key_missing');
      } finally {
        await bare.app.close();
      }
    });

    it('audits resync and delete', async () => {
      await registerWith();
      expect(await auditOf('github_app.resync')).toHaveLength(1);
      const del = await admin.send('delete', ADMIN_ROUTE);
      expect(del.status).toBe(204);
      expect(await auditOf('github_app.delete')).toHaveLength(1);
      expect(await ctx.prisma.gitHubInstallation.count()).toBe(0);
      expect((await admin.get(ADMIN_ROUTE)).body).toEqual({
        registered: false,
        publicUrl: 'https://dock.example',
        encryptionAvailable: true,
      });
    });
  });

  describe('signature and dedupe (D5, D6)', () => {
    beforeEach(async () => {
      await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith();
      ctx.sender.sent = [];
    });

    it('accepts a signed delivery; 401 on a wrong signature, modified body or missing header', async () => {
      const ok = await deliver(ctx, 'issues', issuesLabeled());
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ status: 'accepted' });

      const wrong = await deliver(ctx, 'issues', issuesLabeled(), {
        secret: 'not-the-secret',
      });
      const missing = await deliver(ctx, 'issues', issuesLabeled(), {
        signature: null,
      });
      const body = JSON.stringify(issuesLabeled());
      const modified = await ctx
        .http()
        .post('/hooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issues')
        .set('X-GitHub-Delivery', 'd-modified')
        .set('X-Hub-Signature-256', signGitHubDelivery(WEBHOOK_SECRET, body))
        .send(body.replace('labeled', 'unlabeled'));
      for (const res of [wrong, missing, modified]) {
        expect(res.status).toBe(401);
        expect(res.text).not.toContain('signature');
      }
      const app = await ctx.prisma.gitHubApp.findUniqueOrThrow({
        where: { id: 'app' },
      });
      // C-116: counted in memory, the row written at most once a minute.
      expect(app.signatureFailures).toBe(1);

      await ctx.app.get(GitHubHookService).debouncer.flushAll();
      expect(ctx.sender.sent).toHaveLength(1);
      expect(await ctx.prisma.gitHubDelivery.count()).toBe(1);
    });

    it('100 unsigned deliveries write lastSignatureFailureAt once, and health stays healthy beside valid ones (C-116)', async () => {
      const hooks = ctx.app.get(GitHubHookService);
      const update = jest.spyOn(ctx.prisma.gitHubApp, 'update');
      for (let i = 0; i < 100; i += 1) {
        await expect(
          hooks.receive({
            rawBody: Buffer.from('{}'),
            signature: 'sha256=bad',
            deliveryId: `junk-${i}`,
            event: 'issues',
          }),
        ).rejects.toThrow();
      }
      const failureWrites = update.mock.calls.filter(
        ([args]) => 'lastSignatureFailureAt' in args.data,
      );
      update.mockRestore();
      expect(failureWrites).toHaveLength(1);

      const ok = await deliver(ctx, 'issues', issuesLabeled());
      expect(ok.status).toBe(200);
      await ctx.app.get(GitHubHealthService).recompute();
      const project = await ctx.prisma.project.findFirstOrThrow();
      const health = await ctx.prisma.gitHubProjectHealth.findUniqueOrThrow({
        where: { projectId: project.id },
      });
      expect(health.reason).not.toBe('signature_failure');
    });

    it('throttles the 11th refused delivery in a minute from one address; valid ones still pass (C-116)', async () => {
      for (let i = 0; i < 10; i += 1) {
        const res = await deliver(ctx, 'issues', issuesLabeled(), {
          secret: 'wrong',
        });
        expect(res.status).toBe(401);
      }
      const eleventh = await deliver(ctx, 'issues', issuesLabeled(), {
        secret: 'wrong',
      });
      expect(eleventh.status).toBe(429);
    });

    it('a valid delivery before any refusal is never counted (C-116)', async () => {
      for (let i = 0; i < 15; i += 1) {
        const res = await deliver(ctx, 'issues', issuesLabeled());
        expect(res.status).toBe(200);
      }
    });

    it('answers 200 duplicate to a redelivery, and polls once in total', async () => {
      const first = await deliver(ctx, 'issues', issuesLabeled(), {
        deliveryId: 'same-guid',
      });
      const second = await deliver(ctx, 'issues', issuesLabeled(), {
        deliveryId: 'same-guid',
      });
      expect(first.body).toEqual({ status: 'accepted' });
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ status: 'duplicate' });
      await ctx.app.get(GitHubHookService).debouncer.flushAll();
      expect(ctx.sender.sent).toHaveLength(1);
      expect(
        await ctx.prisma.event.count({ where: { source: 'github' } }),
      ).toBe(1);
    });

    it('is routed to the GitHub handler, not to #26’s /hooks/:publicId', async () => {
      await admin.send('delete', ADMIN_ROUTE);
      // No App: 401 from this module; a trigger route would answer 404.
      const res = await deliver(ctx, 'ping', {});
      expect(res.status).toBe(401);
    });

    it('takes a body over #26’s 256 KB limit (its own 5 MB limit)', async () => {
      const big = { ...issuesLabeled(), padding: 'x'.repeat(300 * 1024) };
      expect((await deliver(ctx, 'issues', big)).status).toBe(200);
    });
  });

  describe('mapping, polls and events rows (D7–D9)', () => {
    it('polls issues on every project of the repo within 5 s and writes one github row each', async () => {
      const a = await seedRepoProject(
        ctx.prisma,
        'andreybegma/agentdock',
        '/srv/a',
      );
      const b = await seedRepoProject(ctx.prisma, REPO, '/srv/b');
      await seedRepoProject(ctx.prisma, 'acme/other', '/srv/c');
      await registerWith();
      ctx.sender.sent = [];

      const started = Date.now();
      const res = await deliver(ctx, 'issues', issuesLabeled());
      expect(res.status).toBe(200);
      await eventually(() => ctx.sender.sent.length === 2);
      for (const sent of ctx.sender.sent)
        expect(sent.at - started).toBeLessThan(5_000);
      expect(ctx.sender.sent.map((s) => [s.runnerId, s.args]).sort()).toEqual(
        [
          [a.runnerId, { projectId: a.projectId, collectors: ['issues'] }],
          [b.runnerId, { projectId: b.projectId, collectors: ['issues'] }],
        ].sort(),
      );

      const rows = await ctx.prisma.event.findMany({
        where: { source: 'github' },
        orderBy: { projectRoot: 'asc' },
      });
      expect(rows.map((r) => [r.type, r.runnerId, r.projectRoot])).toEqual([
        ['github.issues', a.runnerId, '/srv/a'],
        ['github.issues', b.runnerId, '/srv/b'],
      ]);
      for (const row of rows) {
        expect(row.seq < 0n).toBe(true);
        expect(row.data).toEqual({
          action: 'labeled',
          number: 27,
          sender: 'archi',
          state: 'open',
        });
      }
      const delivery = await ctx.prisma.gitHubDelivery.findFirstOrThrow();
      expect(delivery).toMatchObject({
        event: 'issues',
        fullName: 'andreybegma/agentdock',
        projectsMatched: 2,
        handled: true,
      });
    });

    it('debounces a burst of 20 check_run deliveries into one poll', async () => {
      await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith();
      ctx.sender.sent = [];
      await Promise.all(
        Array.from({ length: 20 }, () =>
          deliver(ctx, 'check_run', {
            action: 'completed',
            check_run: { status: 'completed', conclusion: 'success' },
            repository: { full_name: REPO },
            installation: { id: 77 },
          }),
        ),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, ctx.options.debounceMs * 3),
      );
      expect(ctx.sender.sent).toHaveLength(1);
      expect(ctx.sender.sent[0].args.collectors).toEqual(['prs']);
    });

    it('polls prs and worktrees on a push to the base branch only', async () => {
      const develop = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await seedRepoProject(ctx.prisma, REPO, '/srv/b', { baseBranch: 'main' });
      await registerWith();
      ctx.sender.sent = [];

      await deliver(ctx, 'push', {
        ref: 'refs/heads/develop',
        repository: { full_name: REPO },
        installation: { id: 77 },
      });
      await deliver(ctx, 'push', {
        ref: 'refs/heads/feat/27-x',
        repository: { full_name: REPO },
        installation: { id: 77 },
      });
      await ctx.app.get(GitHubHookService).debouncer.flushAll();
      expect(ctx.sender.sent.map((s) => s.args)).toEqual([
        { projectId: develop.projectId, collectors: ['prs', 'worktrees'] },
      ]);
    });

    it('answers within 2 s while the runner is slow or offline', async () => {
      await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith();
      ctx.sender.delayMs = 5_000;
      ctx.sender.outcome = 'failed';
      const started = Date.now();
      const res = await deliver(ctx, 'issues', issuesLabeled());
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_000);
      ctx.sender.outcome = 'sent';
      ctx.app.get(GitHubHookService).debouncer.clear();
    });

    it('keeps runner seqs and the ack cursor apart from its negative seqs', async () => {
      const { runnerId } = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith();
      await deliver(ctx, 'issues', issuesLabeled());
      await deliver(ctx, 'issues', issuesLabeled());
      const ingest = ctx.app.get(RunnerIngestService);
      const ack = await ingest.events(runnerId, [
        {
          v: 1,
          seq: 1,
          ts: new Date().toISOString(),
          type: 'runner.started',
          source: 'runner',
          data: {},
        },
      ]);
      expect(ack).toBe(1n);
      const seqs = (
        await ctx.prisma.event.findMany({
          where: { runnerId },
          orderBy: { seq: 'asc' },
          select: { seq: true },
        })
      ).map((e) => e.seq);
      expect(seqs).toHaveLength(3);
      expect(seqs.filter((s) => s < 0n)).toHaveLength(2);
      expect(seqs.at(-1)).toBe(1n);
    });
  });

  describe('repository id and renames (D7)', () => {
    const NEW_NAME = 'AndreyBegma/Nautelle';
    const REPO_ID = 1000;
    const labeled = (fullName: string, id: number) => ({
      ...issuesLabeled(fullName),
      repository: { id, full_name: fullName },
    });
    const stored = (projectId: string) =>
      ctx.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { repo: true, githubRepoId: true },
      });
    const polled = async () => {
      await ctx.app.get(GitHubHookService).debouncer.flushAll();
      const ids = ctx.sender.sent.map((s) => s.args.projectId);
      ctx.sender.sent = [];
      return ids;
    };

    it('falls back to the name and stores the repository id it finds', async () => {
      const { projectId } = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith();
      ctx.sender.sent = [];

      expect(
        (await deliver(ctx, 'issues', labeled(REPO, REPO_ID))).status,
      ).toBe(200);
      expect(await polled()).toEqual([projectId]);
      expect(await stored(projectId)).toEqual({
        repo: REPO,
        githubRepoId: BigInt(REPO_ID),
      });
      // No id in the payload: the name alone still routes.
      await deliver(ctx, 'issues', issuesLabeled());
      expect(await polled()).toEqual([projectId]);
      expect(await auditOf('project.repo_rename')).toEqual([]);
    });

    it('routes by id after a rename on GitHub and takes the new name, audited', async () => {
      const { projectId, runnerId } = await seedRepoProject(
        ctx.prisma,
        REPO,
        '/srv/a',
      );
      await registerWith();
      await deliver(ctx, 'issues', labeled(REPO, REPO_ID));
      ctx.sender.sent = [];

      const deliveryId = 'renamed-delivery-1';
      const res = await deliver(ctx, 'issues', labeled(NEW_NAME, REPO_ID), {
        deliveryId,
      });
      expect(res.status).toBe(200);
      expect(await polled()).toEqual([projectId]);
      expect(await stored(projectId)).toEqual({
        repo: NEW_NAME,
        githubRepoId: BigInt(REPO_ID),
      });
      // The renaming delivery's row already carries the new name.
      const rows = await ctx.prisma.event.findMany({
        where: { runnerId, source: 'github' },
        select: { projectRepo: true },
      });
      expect(rows.map((r) => r.projectRepo).sort()).toEqual(
        [REPO, NEW_NAME].sort(),
      );

      const audits = await auditOf('project.repo_rename');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: 'system',
        projectId,
        targetType: 'project',
        targetId: projectId,
        before: { repo: REPO },
        after: { repo: NEW_NAME },
        result: 'ok',
      });
      expect(audits[0].meta).toMatchObject({
        via: 'github',
        event: 'issues',
        deliveryId,
        repoId: REPO_ID,
      });

      // A new repository that took the old name is not this project's.
      await deliver(ctx, 'issues', labeled(REPO, 5555));
      expect(await polled()).toEqual([]);
      expect((await stored(projectId)).repo).toBe(NEW_NAME);
    });

    it('takes the new name from repository renamed, even before the id is known', async () => {
      const { projectId } = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      const other = await seedRepoProject(ctx.prisma, 'acme/other', '/srv/b');
      await registerWith();
      ctx.sender.sent = [];
      ctx.github.calls = [];

      const res = await deliver(ctx, 'repository', {
        action: 'renamed',
        changes: { repository: { name: { from: 'AgentDock' } } },
        repository: {
          id: REPO_ID,
          full_name: NEW_NAME,
          owner: { login: 'AndreyBegma' },
        },
        installation: { id: 77 },
        sender: { login: 'archi' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'accepted' });
      expect(await stored(projectId)).toEqual({
        repo: NEW_NAME,
        githubRepoId: BigInt(REPO_ID),
      });
      expect(await stored(other.projectId)).toEqual({
        repo: 'acme/other',
        githubRepoId: null,
      });
      expect(await polled()).toEqual([]);
      const delivery = await ctx.prisma.gitHubDelivery.findFirstOrThrow({
        where: { event: 'repository' },
      });
      expect(delivery).toMatchObject({ handled: true, projectsMatched: 1 });
      expect(await auditOf('project.repo_rename')).toHaveLength(1);
      // The installation's repositories are listed again under the new name.
      await eventually(() => ctx.github.calls.length > 0);

      // The next event under the new name reaches the project.
      await deliver(ctx, 'pull_request', {
        action: 'opened',
        pull_request: { number: 3, state: 'open' },
        repository: { id: REPO_ID, full_name: NEW_NAME },
        installation: { id: 77 },
      });
      expect(await polled()).toEqual([projectId]);
    });
  });

  describe('coverage, health and the watch list (D10–D12)', () => {
    it('makes an uncovered project covered after installation_repositories and resync', async () => {
      const { projectId } = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith(['acme/other']);
      const before = await admin.get(`/projects/${projectId}/github-app`);
      expect(before.body).toMatchObject({
        covered: false,
        state: 'unhealthy',
        reason: 'not_covered',
      });

      ctx.github.installations[0].repos.push({ id: 2000, fullName: REPO });
      const res = await deliver(ctx, 'installation_repositories', {
        action: 'added',
        installation: { id: 77 },
      });
      expect(res.status).toBe(200);
      await eventually(async () => {
        const row = await ctx.prisma.gitHubProjectHealth.findUnique({
          where: { projectId },
        });
        return row?.covered === true;
      });
      const after = await admin.get(`/projects/${projectId}/github-app`);
      expect(after.body).toMatchObject({ covered: true, state: 'healthy' });
    });

    it('tells the runner githubApp: healthy, and drops it after a signature failure', async () => {
      const { runnerId } = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      await registerWith();
      await deliver(ctx, 'issues', issuesLabeled());
      const health = ctx.app.get(GitHubHealthService);
      await health.recompute();
      const watch = ctx.app.get(RunnerWatchList);
      expect((await watch.configFor(runnerId)).projects[0].githubApp).toBe(
        'healthy',
      );
      const tracker = ctx.app.get(SignatureFailureTracker);
      for (let i = 0; i <= SIGNATURE_FAILURE_THRESHOLD; i += 1)
        tracker.record(new Date());
      await health.recompute();
      // Absent on the wire means unhealthy (D12).
      expect(
        (await watch.configFor(runnerId)).projects[0].githubApp,
      ).toBeUndefined();
    });

    it('keeps every project unhealthy without PUBLIC_URL (inactive hook)', async () => {
      const bare = await createGitHubApp({ publicUrl: null });
      try {
        await resetGitHub(bare.prisma);
        await createUser(bare.prisma, 'ian@example.com', 'admin');
        const ian = await login(bare, 'ian@example.com');
        const { projectId } = await seedRepoProject(
          bare.prisma,
          REPO,
          '/srv/a',
        );
        const manifest = await ian.send('post', `${ADMIN_ROUTE}/manifest`, {});
        const body = manifest.body as GitHubManifestResponse;
        expect(body.manifest.hook_attributes.active).toBe(false);
        await ian.get(
          `${ADMIN_ROUTE}/callback?code=${MANIFEST_CODE}&state=${body.state}`,
        );
        bare.github.installations = [
          { id: 77, login: 'x', repos: [{ id: 1, fullName: REPO }] },
        ];
        await ian.send('post', `${ADMIN_ROUTE}/resync`);
        const status = await ian.get(`/projects/${projectId}/github-app`);
        expect(status.body).toMatchObject({
          covered: true,
          state: 'unhealthy',
          reason: 'hook_inactive',
        });
        const view = (await ian.get(ADMIN_ROUTE)).body as GitHubAppView;
        expect(view).toMatchObject({ hookActive: false, publicUrl: null });
      } finally {
        await bare.app.close();
      }
    });
  });

  describe('retention (D17)', () => {
    it('deletes deliveries older than 14 days', async () => {
      const now = new Date('2026-10-10T00:00:00Z');
      await ctx.prisma.gitHubDelivery.createMany({
        data: [
          {
            deliveryId: 'old',
            event: 'ping',
            receivedAt: new Date('2026-09-25T00:00:00Z'),
            handled: true,
            projectsMatched: 0,
          },
          {
            deliveryId: 'new',
            event: 'ping',
            receivedAt: new Date('2026-09-27T00:00:00Z'),
            handled: true,
            projectsMatched: 0,
          },
        ],
      });
      expect(await ctx.app.get(GitHubRetentionJob).sweep(now)).toBe(1);
      expect(
        (await ctx.prisma.gitHubDelivery.findMany()).map((d) => d.deliveryId),
      ).toEqual(['new']);
    });
  });

  describe('authorization (D13, D15)', () => {
    const ROUTES: ['get' | 'post' | 'put' | 'delete', string][] = [
      ['get', ADMIN_ROUTE],
      ['put', ADMIN_ROUTE],
      ['delete', ADMIN_ROUTE],
      ['post', `${ADMIN_ROUTE}/manifest`],
      ['post', `${ADMIN_ROUTE}/resync`],
      ['get', `${ADMIN_ROUTE}/callback?code=a&state=b`],
    ];

    it('answers 403 to operators and viewers on every /admin/github-app route', async () => {
      await createUser(ctx.prisma, 'olga@example.com', 'operator');
      await createUser(ctx.prisma, 'vic@example.com', 'viewer');
      const operator = await login(ctx, 'olga@example.com');
      const viewer = await login(ctx, 'vic@example.com');
      for (const [method, path] of ROUTES) {
        for (const session of [operator, viewer]) {
          const res =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, {});
          expect([method, path, res.status]).toEqual([method, path, 403]);
        }
      }
    });

    it('answers 404 to a non-member and the status to a member', async () => {
      const { projectId } = await seedRepoProject(ctx.prisma, REPO, '/srv/a');
      const member = await createUser(ctx.prisma, 'mia@example.com', 'viewer');
      await createUser(ctx.prisma, 'nil@example.com', 'viewer');
      await ctx.prisma.projectMember.create({
        data: { projectId, userId: member.id },
      });
      const mia = await login(ctx, 'mia@example.com');
      const nil = await login(ctx, 'nil@example.com');
      expect((await nil.get(`/projects/${projectId}/github-app`)).status).toBe(
        404,
      );
      const seen = await mia.get(`/projects/${projectId}/github-app`);
      expect(seen.status).toBe(200);
      expect(seen.body).toMatchObject({ covered: false, state: 'unhealthy' });
    });

    it('exposes collector.poll through no route', () => {
      const instance = ctx.app.getHttpAdapter().getInstance() as {
        router?: { stack: { route?: { path: string } }[] };
        _router?: { stack: { route?: { path: string } }[] };
      };
      const stack = (instance.router ?? instance._router)?.stack ?? [];
      const paths = stack.flatMap((layer) =>
        layer.route ? [layer.route.path] : [],
      );
      expect(paths).toContain('/hooks/github');
      expect(paths.filter((p) => /collector|poll/i.test(p))).toEqual([]);

      // Only the signed hook controller reaches the service that sends polls,
      // and no controller holds the sender itself.
      const controllers = [...ctx.app.get(ModulesContainer).values()].flatMap(
        (module) => [...module.controllers.values()].map((w) => w.metatype),
      );
      const holders = (dep: unknown) =>
        controllers.filter((c) =>
          (
            (Reflect.getMetadata('design:paramtypes', c as object) ??
              []) as unknown[]
          ).includes(dep),
        );
      expect(holders(CollectorPollSender)).toEqual([]);
      expect(holders(GitHubHookService)).toEqual([GitHubHookController]);
    });
  });
});
