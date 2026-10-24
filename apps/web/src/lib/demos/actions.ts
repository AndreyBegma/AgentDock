import type {
  CardDemoView,
  DemoRunnerView,
  DemoSecretView,
  DemoSettingsView,
  UpdateDemoSettingsRequest,
} from '@nautelle/shared';
import { api } from '../api';

/** `/projects/:id/demos` (ADR-0090): members read, a project admin writes. */
const base = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/demos`;

const cardBase = (projectId: string, cardNumber: number) =>
  `/projects/${encodeURIComponent(projectId)}/board/cards/${cardNumber}/demos`;

export const fetchDemoSettings = (projectId: string) =>
  api<DemoSettingsView>(`${base(projectId)}/settings`);

export const saveDemoSettings = (
  projectId: string,
  body: UpdateDemoSettingsRequest,
) =>
  api<DemoSettingsView>(`${base(projectId)}/settings`, {
    method: 'PATCH',
    body,
  });

export const fetchDemoRunner = (projectId: string) =>
  api<DemoRunnerView>(`${base(projectId)}/runner`);

export const fetchDemoSecrets = (projectId: string) =>
  api<DemoSecretView[]>(`${base(projectId)}/secrets`);

/** The value goes up once and never comes back; the answer is the name. */
export const putDemoSecret = (projectId: string, name: string, value: string) =>
  api<DemoSecretView>(
    `${base(projectId)}/secrets/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: { value },
    },
  );

export const deleteDemoSecret = (projectId: string, name: string) =>
  api<void>(`${base(projectId)}/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });

/** Newest first. */
export const fetchCardDemos = (projectId: string, cardNumber: number) =>
  api<CardDemoView[]>(cardBase(projectId, cardNumber));

/** "Record again": operator and above. */
export const requestCardDemo = (projectId: string, cardNumber: number) =>
  api<CardDemoView>(cardBase(projectId, cardNumber), { method: 'POST' });
