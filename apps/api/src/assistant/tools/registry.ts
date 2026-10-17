import type { Role } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuditContext } from '../../audit/audit.types';
import type { AuthUser } from '../../auth/auth-request';
import type { LlmTool } from '../../llm/types';

/** Reads need any member; writes need operator or higher (ADR-0046 §6). */
export type AssistantToolAccess = 'read' | 'write';

export const MIN_ROLE: Record<AssistantToolAccess, Role> = {
  read: 'viewer',
  write: 'operator',
};

/** A project a tool acts on, with the person's role on it. */
export interface ToolProject {
  id: string;
  displayName: string;
  repo: string;
  runnerId: string;
  role: Role;
}

/** What a tool runs with: the person, never more than the person may do. */
export interface AssistantToolContext {
  user: AuthUser;
  ctx: AuditContext;
  conversationId: string;
  /**
   * The project the tool names, or the conversation's. Refused when there is
   * none, when the person cannot see it, or when their role is below `need`.
   */
  project(need: AssistantToolAccess, projectId?: string): Promise<ToolProject>;
  /** Auto: records the project on the conversation. */
  bindProject(projectId: string): Promise<ToolProject>;
}

/** A tool's answer: a one-line step for the person, data for the model. */
export interface AssistantToolResult {
  summary: string;
  data: unknown;
}

/** A refusal the model is told about and may explain; never a crash. */
export class AssistantToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantToolError';
  }
}

export interface AssistantTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** The step shown while it runs, e.g. `Reading the queue`. */
  label: string;
  run(
    input: z.infer<S>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult>;
}

/** Keeps a tool's inferred input type when it goes into a list. */
export const defineTool = <S extends z.ZodType>(
  tool: AssistantTool<S>,
): AssistantTool => tool as unknown as AssistantTool;

/**
 * ADR-0060 §6: the assistant's tools. A module adds its own with `register`
 * in `onModuleInit`; the chat offers every registered tool to the model.
 */
@Injectable()
export class AssistantToolRegistry {
  private readonly tools = new Map<string, AssistantTool>();

  register(...tools: AssistantTool[]): void {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`assistant tool ${tool.name} is registered twice`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): AssistantTool | undefined {
    return this.tools.get(name);
  }

  /** Every tool, as the gateway sends it to a provider. */
  definitions(): LlmTool[] {
    return [...this.tools.values()].map((tool) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.input, {
        io: 'input',
      }) as Record<string, unknown>;
      return { name: tool.name, description: tool.description, inputSchema };
    });
  }
}
