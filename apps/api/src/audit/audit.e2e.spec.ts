import type {
  AuditPage,
  AuditRecordView,
  AuditVerificationState,
} from '@agentdock/shared';
import type { AuditRecord } from '@prisma/client';
import { generatePairingCode } from '../runners/credentials';
import {
  adminSession,
  CapturingLogger,
  createRunner,
  createRunnerE2eApp,
  pairBody,
  type RunnerE2eContext,
  TestRunnerSocket,
} from '../runners/testing/runner-e2e';
import {
  createUser,
  login,
  nextIp,
  PASSWORD,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { AuditService } from './audit.service';
import type { AuditEntry } from './audit.types';
import { AuditVerificationJob } from './audit-verification.job';
import { AuditVerificationService } from './audit-verification.service';
import { GENESIS_HASH } from './canonical';

const NEW_PASSWORD = 'a different horse battery staple';

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF rows. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += c;
  }
  return rows;
};

describe('audit log (e2e)', () => {
  let ctx: RunnerE2eContext;
  let audit: AuditService;
  const logger = new CapturingLogger();
  const sockets: TestRunnerSocket[] = [];

  const head = async (): Promise<bigint> =>
    (
      await ctx.prisma.auditRecord.findFirst({
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
    )?.seq ?? 0n;

  const since = (seq: bigint): Promise<AuditRecord[]> =>
    ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: seq } },
      orderBy: { seq: 'asc' },
    });

  /** Runs `act` and returns exactly the records it wrote. */
  const recordsOf = async (act: () => Promise<unknown>) => {
    const before = await head();
    await act();
    return since(before);
  };

  const rawLogin = (email: string, password: string) =>
    ctx
      .http()
      .post('/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set('User-Agent', 'audit-e2e')
      .send({ email, password });

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({ pingTimeoutMs: 1_500 }, logger);
    audit = ctx.app.get(AuditService);
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.prisma));
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  describe('retrofit: every action writes its record', () => {
    let admin: Session;
    let adminId: string;

    beforeEach(async () => {
      admin = await adminSession(ctx);
      adminId = (
        await ctx.prisma.user.findUniqueOrThrow({
          where: { email: 'admin@example.com' },
        })
      ).id;
    });

    it('auth: login ok / denied, logout, register, password change, session revoke', async () => {
      const user = await createUser(ctx.prisma, 'user@example.com', 'viewer');

      const [ok] = await recordsOf(async () => {
        expect((await rawLogin('user@example.com', PASSWORD)).status).toBe(200);
      });
      expect(ok).toMatchObject({
        action: 'auth.login',
        actorType: 'user',
        actorUserId: user.id,
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        meta: expect.objectContaining({ userAgent: 'audit-e2e' }),
      });
      expect((ok.meta as Record<string, unknown>).ip).toEqual(
        expect.any(String),
      );

      for (const [email, password] of [
        ['user@example.com', 'wrong password!!'],
        ['nobody@example.com', PASSWORD],
      ]) {
        const rows = await recordsOf(async () => {
          expect((await rawLogin(email, password)).status).toBe(401);
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'auth.login',
          actorType: 'anonymous',
          actorUserId: null,
          targetType: 'email',
          targetId: email,
          result: 'denied',
          meta: expect.objectContaining({ reason: 'invalid_credentials' }),
        });
        const { before, after, meta } = rows[0];
        expect(JSON.stringify([before, after, meta])).not.toContain(password);
      }

      await createUser(ctx.prisma, 'pending@example.com', 'viewer', 'pending');
      const [pending] = await recordsOf(async () => {
        expect((await rawLogin('pending@example.com', PASSWORD)).status).toBe(
          403,
        );
      });
      expect(pending).toMatchObject({
        result: 'denied',
        meta: expect.objectContaining({ reason: 'pending_approval' }),
      });

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() + 60_000) },
      });
      const [locked] = await recordsOf(() =>
        rawLogin('user@example.com', PASSWORD),
      );
      expect(locked).toMatchObject({
        result: 'denied',
        meta: expect.objectContaining({ reason: 'locked' }),
      });
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: null, failedLoginCount: 0 },
      });

      const session = await login(ctx, 'user@example.com');
      const other = await login(ctx, 'user@example.com');
      const sessions = (await session.get('/auth/sessions')).body as {
        id: string;
        current: boolean;
      }[];
      const otherId = sessions.find((s) => !s.current)?.id;
      const [revoke] = await recordsOf(async () => {
        expect(
          (await session.send('delete', `/auth/sessions/${otherId}`)).status,
        ).toBe(204);
      });
      expect(revoke).toMatchObject({
        action: 'auth.session_revoke',
        actorUserId: user.id,
        targetType: 'session',
        targetId: otherId,
        result: 'ok',
      });
      expect(other.token).toBeDefined();

      const changed = await recordsOf(async () => {
        expect(
          (
            await session.send('patch', '/auth/me/password', {
              currentPassword: PASSWORD,
              newPassword: NEW_PASSWORD,
            })
          ).status,
        ).toBe(204);
      });
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        action: 'auth.password_change',
        actorUserId: user.id,
        targetType: 'user',
        targetId: user.id,
      });

      const [logout] = await recordsOf(() =>
        session.send('post', '/auth/logout'),
      );
      expect(logout).toMatchObject({
        action: 'auth.logout',
        actorUserId: user.id,
        targetType: 'session',
        result: 'ok',
      });

      const [toggle] = await recordsOf(() =>
        admin.send('put', '/admin/settings/registration', { open: true }),
      );
      expect(toggle).toMatchObject({
        action: 'settings.registration',
        actorUserId: adminId,
        targetType: 'setting',
        targetId: 'registration.open',
        before: { open: false },
        after: { open: true },
      });

      const registered = await recordsOf(async () => {
        const response = await ctx
          .http()
          .post('/auth/register')
          .set('X-Forwarded-For', nextIp())
          .send({ email: 'new@example.com', password: PASSWORD, name: 'New' });
        expect(response.status).toBe(201);
      });
      const created = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'new@example.com' },
      });
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({
        action: 'auth.register',
        actorType: 'anonymous',
        targetType: 'user',
        targetId: created.id,
        after: { email: 'new@example.com', name: 'New', status: 'pending' },
      });
    });

    it('admin users: approve, reject, role change, disable, delete', async () => {
      const a = await createUser(
        ctx.prisma,
        'a@example.com',
        'viewer',
        'pending',
      );
      const b = await createUser(
        ctx.prisma,
        'b@example.com',
        'viewer',
        'pending',
      );
      const expectOne = async (
        act: () => Promise<{ status: number }>,
        expected: Partial<AuditRecord>,
      ) => {
        const rows = await recordsOf(async () => {
          expect((await act()).status).toBeLessThan(300);
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actorType: 'user',
          actorUserId: adminId,
          targetType: 'user',
          result: 'ok',
          ...expected,
        });
      };

      await expectOne(
        () =>
          admin.send('post', `/admin/users/${a.id}/approve`, {
            role: 'operator',
          }),
        {
          action: 'user.approve',
          targetId: a.id,
          before: { status: 'pending', role: 'viewer' },
          after: { status: 'active', role: 'operator' },
        },
      );
      await expectOne(() => admin.send('post', `/admin/users/${b.id}/reject`), {
        action: 'user.reject',
        targetId: b.id,
        before: { status: 'pending' },
        after: { status: 'rejected' },
      });
      await expectOne(
        () => admin.send('patch', `/admin/users/${a.id}`, { role: 'viewer' }),
        {
          action: 'user.update',
          targetId: a.id,
          before: { role: 'operator' },
          after: { role: 'viewer' },
        },
      );
      await expectOne(
        () =>
          admin.send('patch', `/admin/users/${a.id}`, { status: 'disabled' }),
        {
          action: 'user.update',
          targetId: a.id,
          before: { status: 'active' },
          after: { status: 'disabled' },
        },
      );
      await expectOne(() => admin.send('delete', `/admin/users/${a.id}`), {
        action: 'user.delete',
        targetId: a.id,
        before: { email: 'a@example.com', role: 'viewer', status: 'disabled' },
      });

      // A refused mutation changes nothing and records nothing.
      expect(
        await recordsOf(() =>
          admin.send('post', `/admin/users/${b.id}/approve`, {
            role: 'viewer',
          }),
        ),
      ).toEqual([]);
    });

    it('runners: create, pairing code, pair ok / denied, rename, revoke, command', async () => {
      let pairingCode = '';
      let runnerId = '';
      const [create] = await recordsOf(async () => {
        const created = await createRunner(admin, 'desk');
        pairingCode = created.pairingCode;
        runnerId = created.runner.id;
      });
      expect(create).toMatchObject({
        action: 'runner.create',
        actorUserId: adminId,
        targetType: 'runner',
        targetId: runnerId,
        after: { name: 'desk' },
        result: 'ok',
      });

      const [code] = await recordsOf(async () => {
        const response = await admin.send(
          'post',
          `/admin/runners/${runnerId}/pairing-code`,
        );
        pairingCode = response.body.pairingCode;
      });
      expect(code).toMatchObject({
        action: 'runner.pairing_code',
        actorUserId: adminId,
        targetId: runnerId,
      });

      const pair = () =>
        ctx
          .http()
          .post('/runners/pair')
          .set('X-Forwarded-For', nextIp())
          .send(pairBody(pairingCode));
      let token = '';
      const [paired] = await recordsOf(async () => {
        const response = await pair();
        expect(response.status).toBe(200);
        token = response.body.token;
      });
      expect(paired).toMatchObject({
        action: 'runner.pair',
        actorType: 'runner',
        actorRunnerId: runnerId,
        targetId: runnerId,
        after: { hostname: 'test-host', version: '0.1.0' },
        result: 'ok',
      });

      const [reused] = await recordsOf(async () => {
        expect((await pair()).status).toBe(400);
      });
      expect(reused).toMatchObject({
        action: 'runner.pair',
        actorType: 'anonymous',
        targetType: 'runner',
        targetId: runnerId,
        result: 'denied',
        meta: expect.objectContaining({ reason: 'invalid_code' }),
      });
      const [unknown] = await recordsOf(() =>
        ctx
          .http()
          .post('/runners/pair')
          .set('X-Forwarded-For', nextIp())
          .send(pairBody(generatePairingCode())),
      );
      expect(unknown).toMatchObject({
        action: 'runner.pair',
        targetId: null,
        result: 'denied',
      });

      const [rename] = await recordsOf(() =>
        admin.send('patch', `/admin/runners/${runnerId}`, { name: 'laptop' }),
      );
      expect(rename).toMatchObject({
        action: 'runner.rename',
        before: { name: 'desk' },
        after: { name: 'laptop' },
      });

      const socket = new TestRunnerSocket(ctx.origin, token);
      sockets.push(socket);
      await socket.connect();
      const commandRows = await recordsOf(async () => {
        const sent = admin
          .send('post', `/admin/runners/${runnerId}/ping`)
          .then((r) => r);
        const command = await socket.next('command');
        socket.send({
          type: 'command.result',
          id: command.id,
          ok: true,
          output: { pong: true, ts: new Date().toISOString() },
        });
        expect((await sent).status).toBe(200);
      });
      expect(commandRows).toEqual([
        expect.objectContaining({
          action: 'runner.command',
          actorUserId: adminId,
          targetId: runnerId,
          result: 'requested',
          after: { name: 'runner.ping', args: {} },
        }),
        expect.objectContaining({
          action: 'runner.command.result',
          actorUserId: adminId,
          targetId: runnerId,
          result: 'ok',
          after: { ok: true },
        }),
      ]);

      const [revoke] = await recordsOf(() =>
        admin.send('post', `/admin/runners/${runnerId}/revoke`),
      );
      expect(revoke).toMatchObject({
        action: 'runner.revoke',
        targetId: runnerId,
        before: { revokedAt: null },
        after: { revokedAt: expect.any(String) },
      });
    });

    it('no record carries a password, hash, token or pairing code', async () => {
      const start = await head();
      const secrets: string[] = [PASSWORD, NEW_PASSWORD];

      await admin.send('put', '/admin/settings/registration', { open: true });
      await ctx
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'u@example.com', password: PASSWORD });
      const u = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'u@example.com' },
      });
      await admin.send('post', `/admin/users/${u.id}/approve`, {
        role: 'viewer',
      });
      await rawLogin('u@example.com', 'not the password at all');
      const session = await login(ctx, 'u@example.com');
      secrets.push(session.token, session.csrf, admin.token, admin.csrf);
      await session.send('patch', '/auth/me/password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      await session.send('post', '/auth/logout');
      await admin.send('patch', `/admin/users/${u.id}`, { role: 'operator' });

      const created = await createRunner(admin);
      secrets.push(created.pairingCode);
      const paired = await ctx
        .http()
        .post('/runners/pair')
        .set('X-Forwarded-For', nextIp())
        .send(pairBody(created.pairingCode));
      secrets.push(paired.body.token);
      const runner = await ctx.prisma.runner.findUniqueOrThrow({
        where: { id: created.runner.id },
      });
      if (runner.tokenHash) secrets.push(runner.tokenHash);
      for (const row of await ctx.prisma.userSession.findMany()) {
        secrets.push(row.tokenHash);
      }
      for (const row of await ctx.prisma.user.findMany()) {
        secrets.push(row.passwordHash);
      }
      await admin.send('post', `/admin/runners/${created.runner.id}/revoke`);
      await admin.send('delete', `/admin/users/${u.id}`);

      const rows = await since(start);
      expect(rows.length).toBeGreaterThan(10);
      for (const row of rows) {
        const text = JSON.stringify([row.before, row.after, row.meta]);
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    });
  });

  it('the database refuses UPDATE, DELETE and TRUNCATE', async () => {
    await audit.record({
      actor: { type: 'system' },
      action: 'user.create',
      target: { type: 'test' },
      result: 'ok',
    });
    for (const sql of [
      `UPDATE audit_records SET action = 'x'`,
      'DELETE FROM audit_records',
      'TRUNCATE audit_records',
    ]) {
      await expect(ctx.prisma.$executeRawUnsafe(sql)).rejects.toThrow(
        'audit_records is append-only',
      );
    }
  });

  it('50 concurrent records form one unbroken chain', async () => {
    const start = await head();
    const previous = await ctx.prisma.auditRecord.findFirst({
      where: { seq: start },
    });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        audit.record({
          actor: { type: 'system' },
          action: 'runner.command',
          target: { type: 'concurrency', id: String(i) },
          result: 'requested',
        }),
      ),
    );
    const rows = await since(start);
    expect(rows).toHaveLength(50);
    let prevHash = previous?.hash ?? GENESIS_HASH;
    for (const row of rows) {
      expect(row.prevHash).toBe(prevHash);
      prevHash = row.hash;
    }
    expect((await ctx.app.get(AuditVerificationService).verify()).ok).toBe(
      true,
    );
  });

  describe('verification', () => {
    let admin: Session;
    beforeEach(async () => {
      admin = await adminSession(ctx);
    });

    it('finds a hand-edited row once the trigger is dropped', async () => {
      await audit.record({
        actor: { type: 'system' },
        action: 'user.create',
        target: { type: 'tamper' },
        after: { name: 'original' },
        result: 'ok',
      });
      const target = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { targetType: 'tamper' },
        orderBy: { seq: 'desc' },
      });
      // Later rows exist too: the break must be reported at the edited one.
      await audit.record({
        actor: { type: 'system' },
        action: 'user.create',
        target: { type: 'tamper-after' },
        result: 'ok',
      });

      const intact = await admin.send('post', '/admin/audit/verification');
      expect(intact.status).toBe(200);
      expect(intact.body).toMatchObject({ ok: true });

      await ctx.prisma.$executeRawUnsafe(
        'DROP TRIGGER audit_records_no_update_delete ON audit_records',
      );
      try {
        await ctx.prisma.$executeRaw`
          UPDATE audit_records SET after = '{"name":"forged"}'::jsonb
          WHERE seq = ${target.seq}`;
        const broken = await admin.send('post', '/admin/audit/verification');
        expect(broken.body).toMatchObject({
          ok: false,
          firstBrokenSeq: target.seq.toString(),
        });
        // Restore, so the chain stays valid for every later test.
        await ctx.prisma.$executeRaw`
          UPDATE audit_records SET after = '{"name":"original"}'::jsonb
          WHERE seq = ${target.seq}`;
      } finally {
        await ctx.prisma.$executeRawUnsafe(`
          CREATE TRIGGER audit_records_no_update_delete
            BEFORE UPDATE OR DELETE ON audit_records
            FOR EACH ROW EXECUTE FUNCTION audit_records_immutable()`);
      }
      const restored = await admin.send('post', '/admin/audit/verification');
      expect(restored.body).toMatchObject({ ok: true });
      expect(logger.lines.join('\n')).toContain(
        `audit chain broken at seq ${target.seq}`,
      );
    });

    it('the nightly job stores its result; GET returns it', async () => {
      expect(
        (
          (await admin.get('/admin/audit/verification'))
            .body as AuditVerificationState
        ).last,
      ).toBeNull();
      await ctx.app.get(AuditVerificationJob).run();
      const stored = await ctx.prisma.setting.findUniqueOrThrow({
        where: { key: 'audit.lastVerification' },
      });
      const state = (await admin.get('/admin/audit/verification'))
        .body as AuditVerificationState;
      expect(state.last).toEqual(stored.value);
      expect(state.last).toMatchObject({
        ok: true,
        checked: expect.any(Number),
        verifiedAt: expect.any(String),
      });
    });
  });

  describe('admin API', () => {
    let admin: Session;
    const marker = `filter-${Date.now()}`;
    const seed = async () => {
      const entries: AuditEntry[] = [
        { action: 'runner.create', result: 'ok' },
        { action: 'runner.revoke', result: 'ok' },
        { action: 'runner.pair', result: 'denied' },
        { action: 'user.delete', result: 'ok' },
        { action: 'runner.rename', result: 'ok' },
      ].map((e, i) => ({
        actor: { type: 'system' },
        action: e.action as AuditEntry['action'],
        result: e.result as AuditEntry['result'],
        target: { type: marker, id: `t${i}` },
        projectId: i % 2 === 0 ? 'proj-even' : null,
      }));
      for (const entry of entries) await audit.record(entry);
    };

    beforeEach(async () => {
      admin = await adminSession(ctx);
    });

    it('filters return only matching rows; the cursor returns each row once', async () => {
      await seed();
      const list = async (query: Record<string, string>) =>
        (await admin.get('/admin/audit').query(query)).body as AuditPage;

      const all = await list({ targetType: marker });
      expect(all.items.map((r) => r.targetId)).toEqual([
        't4',
        't3',
        't2',
        't1',
        't0',
      ]);
      expect(
        (await list({ targetType: marker, action: 'runner.' })).items.map(
          (r) => r.action,
        ),
      ).toEqual([
        'runner.rename',
        'runner.pair',
        'runner.revoke',
        'runner.create',
      ]);
      expect(
        (await list({ targetType: marker, result: 'denied' })).items.map(
          (r) => r.targetId,
        ),
      ).toEqual(['t2']);
      expect(
        (await list({ targetType: marker, projectId: 'proj-even' })).items.map(
          (r) => r.targetId,
        ),
      ).toEqual(['t4', 't2', 't0']);
      expect(
        (await list({ targetType: marker, targetId: 't3' })).items,
      ).toHaveLength(1);
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect((await list({ targetType: marker, from: future })).items).toEqual(
        [],
      );
      expect(
        (await list({ targetType: marker, to: future })).items,
      ).toHaveLength(5);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: AuditPage = await list({
          targetType: marker,
          limit: '2',
          ...(cursor ? { cursor } : {}),
        });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((r) => r.seq));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.items.map((r) => r.seq));
      expect(new Set(seen).size).toBe(5);

      const one = await admin.get(`/admin/audit/${all.items[0].seq}`);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        seq: all.items[0].seq,
        prevHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect((await admin.get('/admin/audit/999999999999')).status).toBe(404);
      expect((await admin.get('/admin/audit/abc')).status).toBe(404);
      expect(
        (await admin.get('/admin/audit').query({ limit: '201' })).status,
      ).toBe(400);
    });

    it('exports the filtered set as CSV with JSON columns intact', async () => {
      const tricky = {
        note: 'comma, "quote"\nnewline',
        nested: { list: [1, 'two'] },
      };
      await audit.record({
        actor: { type: 'system' },
        action: 'user.create',
        target: { type: `${marker}-csv`, id: '=HYPERLINK("x")' },
        after: tricky,
        meta: { via: 'test' },
        result: 'ok',
      });
      await audit.record({
        actor: { type: 'system' },
        action: 'user.create',
        target: { type: `${marker}-csv`, id: 'plain' },
        result: 'ok',
      });

      const response = await admin
        .get('/admin/audit/export.csv')
        .query({ targetType: `${marker}-csv` })
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => done(null, text));
        });
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      const rows = parseCsv(response.body as string);
      expect(rows).toHaveLength(3);
      // Newest first: `plain` was recorded last.
      const [header, second, first] = rows;
      const col = (name: string) => header.indexOf(name);
      expect(header).toContain('after');
      expect(second[col('targetId')]).toBe('plain');
      expect(first[col('targetId')]).toBe(`'=HYPERLINK("x")`);
      expect(JSON.parse(first[col('after')])).toEqual(tricky);
      expect(JSON.parse(first[col('meta')])).toEqual({ via: 'test' });
      expect(second[col('after')]).toBe('');
    });

    it('a deleted user keeps their records, readable by id', async () => {
      const user = await createUser(ctx.prisma, 'gone@example.com', 'viewer');
      await login(ctx, 'gone@example.com');
      await admin.send('delete', `/admin/users/${user.id}`);
      const page = (
        await admin.get('/admin/audit').query({ actorUserId: user.id })
      ).body as AuditPage;
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items[0]).toMatchObject<Partial<AuditRecordView>>({
        actorUserId: user.id,
        actorEmail: null,
        action: 'auth.login',
      });
    });

    it('admin only; nothing modifies a record', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      await createUser(ctx.prisma, 'view@example.com', 'viewer');
      const operator = await login(ctx, 'op@example.com');
      const viewer = await login(ctx, 'view@example.com');
      const reads = [
        '/admin/audit',
        '/admin/audit/1',
        '/admin/audit/verification',
        '/admin/audit/export.csv',
      ];
      for (const caller of [operator, viewer]) {
        for (const path of reads) {
          expect((await caller.get(path)).status).toBe(403);
        }
        expect(
          (await caller.send('post', '/admin/audit/verification')).status,
        ).toBe(403);
      }
      for (const path of reads) {
        expect((await ctx.http().get(path)).status).toBe(401);
      }
      expect((await ctx.http().post('/admin/audit/verification')).status).toBe(
        401,
      );
      for (const method of ['put', 'patch', 'delete'] as const) {
        for (const path of ['/admin/audit', '/admin/audit/1']) {
          expect([404, 405]).toContain(
            (await admin.send(method, path, {})).status,
          );
        }
      }
    });
  });

  it('a failed audit write leaves the action result unchanged and logs at error', async () => {
    await createUser(ctx.prisma, 'user@example.com', 'viewer');
    const spy = jest
      .spyOn(
        audit as unknown as { append: (e: AuditEntry) => Promise<void> },
        'append',
      )
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      const rows = await recordsOf(async () => {
        expect((await rawLogin('user@example.com', PASSWORD)).status).toBe(200);
      });
      expect(rows).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(
      logger.lines.some(
        (line) =>
          line.startsWith('error') &&
          line.includes('audit auth.login not recorded: disk full'),
      ),
    ).toBe(true);
    // The next write still lands and links to the chain.
    const [next] = await recordsOf(() =>
      rawLogin('user@example.com', PASSWORD),
    );
    expect(next).toMatchObject({ action: 'auth.login', result: 'ok' });
    expect((await ctx.app.get(AuditVerificationService).verify()).ok).toBe(
      true,
    );
  });
});
