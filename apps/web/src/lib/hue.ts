import { type Hue, hueFor } from '@andrewbehma/glass-ui/hue';

/**
 * Identity colours (#163, glass-ui#109): the one place a thing in AgentDock
 * gets its hue, so a project or a slot wears the same one on every screen.
 * A hue tells things apart; it never says how they are doing — that is the
 * status colours' job (`lib/status/pill.ts`).
 *
 * The keys are stable on purpose: a project by its id (a display name can be
 * renamed), a slot by its name (the orchestrator's own key for it).
 */
export const projectHue = (projectId: string): Hue => hueFor(projectId);

export const slotHue = (slotName: string): Hue => hueFor(slotName);
