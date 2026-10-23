import type { ReviewStepView } from '@nautelle/shared';

/** A review step for tests; `skill-` ids are skill steps, the rest peer review. */
export const step = (
  id: string,
  over: Partial<ReviewStepView> = {},
): ReviewStepView => ({
  id,
  projectId: 'p1',
  position: 0,
  enabled: true,
  name: id,
  type: 'skill',
  instructions: null,
  skillName: 'cs-security',
  instructionsGeneratedAt: null,
  instructionsEditedAt: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
  ...over,
});

export const peerStep = (over: Partial<ReviewStepView> = {}) =>
  step('peer', {
    name: 'Peer review',
    type: 'peer_review',
    skillName: null,
    instructions: '# Review\n\nLook for bugs.',
    instructionsGeneratedAt: '2026-10-22T10:00:00.000Z',
    ...over,
  });
