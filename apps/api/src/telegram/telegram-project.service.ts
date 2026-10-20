import { effectiveProjectRole, type Role } from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit';
import { userActor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { callbackCodec } from './callback-data';
import type {
  InlineKeyboardButton,
  TelegramCallbackQuery,
} from './telegram-client';
import {
  type GuardRefusal,
  type GuardUser,
  type TelegramAccess,
  TelegramGuard,
} from './telegram-guard.service';
import { LINK_REPLIES } from './telegram-linking.service';
import type { CommandContext, TelegramAnswer } from './telegram-router';

/** A project as the bot shows it, with the linked user's role on it. */
export interface TelegramProject {
  id: string;
  displayName: string;
  /** `owner/name` on GitHub. */
  repo: string;
  role: Role;
}

/** How a chat's current project was chosen; recorded in the audit. */
type SelectedVia = 'button' | 'name' | 'only_project';

/** The chat's project for a Board command, or why there is none. */
export type CurrentProject =
  | { ok: true; project: TelegramProject; user: GuardUser }
  | {
      ok: false;
      /** `choose`: several projects and none chosen; `no_project`: none at all. */
      reason: GuardRefusal | 'no_project' | 'choose';
      project?: TelegramProject;
    };

/** `pj:<project id>`: a button of the `/project` list. */
export const PROJECT_CALLBACK = callbackCodec('pj', { project: 'project' });

const LABEL_MAX = 60;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What `/project <name>` matches: the repository's name, in lower case. */
export const projectSlug = (repo: string): string =>
  (repo.slice(repo.lastIndexOf('/') + 1) || repo).toLowerCase();

/** #500: a Board reply names the project it is about, first. */
export const boardReply = (project: { displayName: string }, text: string) =>
  `${project.displayName} · ${text}`;

const REFUSALS: Record<GuardRefusal | 'no_project' | 'choose', string> = {
  not_linked: LINK_REPLIES.notLinked,
  inactive_user: 'Your Nautelle account is not active.',
  not_member: 'You are not a member of this project any more.',
  role: 'Your role on this project does not allow that, so nothing changed.',
  no_project: 'You are not a member of any Nautelle project yet.',
  choose: 'Pick the project for this chat first: send /project.',
};

export const PROJECT_REPLIES = {
  choose:
    'Which project should this chat work on? The Board commands will act on it until you switch.',
  unknownName:
    'You have no project by that name. Send /project to pick from yours.',
  ambiguousName:
    'Several of your projects have that name. Send /project and pick one.',
  invalidButton: 'This button is no longer valid. Send /project again.',
} as const;

/** Why a Board command has no project to act on, in the bot's words. */
export const projectRefusalText = (
  reason: Extract<CurrentProject, { ok: false }>['reason'],
): string => REFUSALS[reason];

const selectedText = (project: TelegramProject, via: SelectedVia): string =>
  boardReply(
    project,
    via === 'only_project'
      ? `your only project, is this chat's project (you are ${project.role}).`
      : `now this chat's project (you are ${project.role}). Board commands act on it until you switch with /project.`,
  );

/**
 * #500: the chat's current project — `telegram_links.currentProjectId`, so it
 * survives restarts. `/project` lists the projects the linked user is an
 * active member of as buttons; `/project <name>` switches by repository name;
 * a user with exactly one project has it chosen without being asked. Every
 * use re-checks membership through `TelegramGuard`: a project the user left
 * is no longer theirs, whatever the link says. Notification buttons never
 * read it — they carry their own project.
 */
@Injectable()
export class TelegramProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: TelegramGuard,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  /** The projects `user` is an active member of, by name. */
  async projectsOf(user: GuardUser): Promise<TelegramProject[]> {
    const rows = await this.prisma.project.findMany({
      where: this.access.visibleWhere(user),
      select: {
        id: true,
        displayName: true,
        repo: true,
        members: { where: { userId: user.id }, select: { roleOverride: true } },
      },
      orderBy: [{ displayName: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      repo: row.repo,
      role:
        user.role === 'admin'
          ? 'admin'
          : effectiveProjectRole(user.role, row.members[0]?.roleOverride),
    }));
  }

  /**
   * The project a Board command in `chatId` acts on, checked for `need`. The
   * stored choice when the user may still see it; else their only project,
   * which is then stored.
   */
  async current(chatId: number, need: TelegramAccess): Promise<CurrentProject> {
    const linked = await this.guard.linkedUser(chatId);
    if (!linked.ok) return { ok: false, reason: linked.reason };
    const { user } = linked;
    const projects = await this.projectsOf(user);
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId: user.id },
      select: { currentProjectId: true },
    });
    let project = projects.find((p) => p.id === link?.currentProjectId);
    if (!project) {
      if (projects.length === 0) return { ok: false, reason: 'no_project' };
      if (projects.length > 1) return { ok: false, reason: 'choose' };
      project = projects[0];
      await this.select(user.id, project, 'only_project');
    }
    const check = await this.guard.member(user.id, project.id, need);
    if (!check.ok) return { ok: false, reason: check.reason, project };
    return { ok: true, project: { ...project, role: check.role }, user };
  }

  /** `/project` and `/project <name>`. */
  async handleCommand(context: CommandContext): Promise<TelegramAnswer> {
    const { chatId } = context;
    const answer = (text: string, extra: Partial<TelegramAnswer> = {}) => ({
      chatId,
      text,
      ...extra,
    });
    if (!context.isPrivate) return answer(LINK_REPLIES.notPrivate);
    const linked = await this.guard.linkedUser(chatId);
    if (!linked.ok) return answer(REFUSALS[linked.reason]);
    const { user } = linked;
    const projects = await this.projectsOf(user);
    if (projects.length === 0) return answer(REFUSALS.no_project);
    if (projects.length === 1) {
      const [only] = projects;
      await this.select(user.id, only, 'only_project');
      return answer(selectedText(only, 'only_project'));
    }
    if (context.args) {
      const name = context.args.toLowerCase();
      const matches = projects.filter(
        (p) => projectSlug(p.repo) === name || p.repo.toLowerCase() === name,
      );
      if (matches.length === 0) return answer(PROJECT_REPLIES.unknownName);
      if (matches.length > 1) return answer(PROJECT_REPLIES.ambiguousName);
      await this.select(user.id, matches[0], 'name');
      return answer(selectedText(matches[0], 'name'));
    }
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId: user.id },
      select: { currentProjectId: true },
    });
    return answer(PROJECT_REPLIES.choose, {
      replyMarkup: {
        inline_keyboard: projectKeyboard(projects, link?.currentProjectId),
      },
    });
  }

  /** A press on one of the `/project` buttons. */
  async handleCallback(query: TelegramCallbackQuery): Promise<TelegramAnswer> {
    const chat = query.message?.chat;
    const chatId = chat?.id ?? query.from.id;
    const answer = (text: string): TelegramAnswer => ({
      chatId,
      text,
      callbackQueryId: query.id,
      notice: text,
    });
    const press = PROJECT_CALLBACK.decode(query.data);
    if (!press || (chat && chat.type !== 'private')) {
      return answer(PROJECT_REPLIES.invalidButton);
    }
    const allowed = await this.guard.authorize(chatId, press.project, 'read');
    if (!allowed.ok) return answer(REFUSALS[allowed.reason]);
    const row = await this.prisma.project.findUnique({
      where: { id: press.project },
      select: { id: true, displayName: true, repo: true },
    });
    if (!row) return answer(REFUSALS.not_member);
    const project = { ...row, role: allowed.role };
    await this.select(allowed.user.id, project, 'button');
    return answer(selectedText(project, 'button'));
  }

  private async select(
    userId: string,
    project: TelegramProject,
    via: SelectedVia,
  ): Promise<void> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId },
      select: { currentProjectId: true },
    });
    if (!link || link.currentProjectId === project.id) return;
    await this.prisma.telegramLink.update({
      where: { userId },
      data: { currentProjectId: project.id },
    });
    await this.audit.record({
      actor: userActor(userId),
      action: 'telegram.project',
      target: { type: 'project', id: project.id },
      projectId: project.id,
      after: { projectId: project.id, selectedBy: via },
      result: 'ok',
      meta: { via: 'telegram' },
    });
  }
}

/** One button per project, its role on it; the current one is ticked. */
export const projectKeyboard = (
  projects: TelegramProject[],
  currentId: string | null | undefined,
): InlineKeyboardButton[][] =>
  projects.map((project) => [
    {
      text: `${clip(project.displayName, LABEL_MAX)} · ${project.role}${
        project.id === currentId ? ' ✓' : ''
      }`,
      callback_data: PROJECT_CALLBACK.encode({ project: project.id }),
    },
  ]);
