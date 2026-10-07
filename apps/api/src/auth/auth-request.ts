import type { PublicUser } from '@agentdock/shared';
import type { Request } from 'express';

export type AuthUser = PublicUser;

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  auth: AuthContext;
}

export const getAuth = (request: Request): AuthContext | undefined =>
  (request as Partial<AuthenticatedRequest>).auth;
