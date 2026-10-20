/**
 * The agent workspace's state in the URL (#160): which agents are open in the
 * dock, which one is in front, and which view the page shows —
 * `?open=i42,i43&focus=i42&view=canvas`. Pure, so the rules are tested without
 * a router; the page reads `URLSearchParams` and writes `toSearch()` back.
 */

/**
 * A slot name as the orchestrator writes it: `slotNameSchema`, 64 at most.
 * Spelled out here because the schema lives in the protocol entry point, which
 * the web's root `@agentdock/shared` import does not carry.
 */
const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** More tabs than this is a pasted link, not a workspace. */
export const OPEN_MAX = 20;

export const ORCHESTRATOR_KEY = 'orchestrator';

export type WorkspaceView = 'canvas' | 'list';

export interface WorkspaceState {
  /** Opened slots, in the order they were opened. */
  open: string[];
  /** The slot (or `orchestrator`) in front; null when nothing is. */
  focus: string | null;
  view: WorkspaceView;
}

export const EMPTY_WORKSPACE: WorkspaceState = {
  open: [],
  focus: null,
  view: 'list',
};

export const isSlotName = (value: string): boolean => SLOT_NAME.test(value);

/** What a link said, cleaned: unknown names dropped, duplicates once, capped. */
export function parseWorkspace(params: {
  get: (key: string) => string | null;
}): WorkspaceState {
  const open: string[] = [];
  for (const raw of (params.get('open') ?? '').split(',')) {
    const name = raw.trim();
    if (name === '' || !isSlotName(name) || open.includes(name)) continue;
    if (open.length === OPEN_MAX) break;
    open.push(name);
  }
  const focusRaw = params.get('focus')?.trim() ?? '';
  const focus =
    focusRaw === ORCHESTRATOR_KEY ||
    (isSlotName(focusRaw) && open.includes(focusRaw))
      ? focusRaw
      : null;
  const view: WorkspaceView =
    params.get('view') === 'canvas' ? 'canvas' : 'list';
  return { open, focus, view };
}

/**
 * The query string for a state, with the leading `?`, or `''` for the empty
 * one. `others` are the page's own parameters, kept as they are.
 */
export function toSearch(
  state: WorkspaceState,
  others: Iterable<[string, string]> = [],
): string {
  const params = new URLSearchParams();
  for (const [key, value] of others) {
    if (key !== 'open' && key !== 'focus' && key !== 'view') {
      params.append(key, value);
    }
  }
  if (state.open.length > 0) params.set('open', state.open.join(','));
  if (state.focus) params.set('focus', state.focus);
  if (state.view === 'canvas') params.set('view', 'canvas');
  // Slot names are `[a-z0-9-]`; a literal comma reads better than `%2C`.
  const text = params.toString().replace(/%2C/g, ',');
  return text ? `?${text}` : '';
}

/** Opens a slot (or brings it to the front when it is open already). */
export function openSlot(state: WorkspaceState, slot: string): WorkspaceState {
  if (slot === ORCHESTRATOR_KEY) return { ...state, focus: slot };
  if (!isSlotName(slot)) return state;
  if (state.open.includes(slot)) return { ...state, focus: slot };
  // At the cap the oldest tab makes room, so the one asked for always opens.
  const kept = state.open.length >= OPEN_MAX ? state.open.slice(1) : state.open;
  return { ...state, open: [...kept, slot], focus: slot };
}

/** Closes a tab; the focus moves to its neighbour, as the dock's Delete does. */
export function closeSlot(state: WorkspaceState, slot: string): WorkspaceState {
  const at = state.open.indexOf(slot);
  if (at < 0) {
    return state.focus === slot ? { ...state, focus: null } : state;
  }
  const open = state.open.filter((s) => s !== slot);
  if (state.focus !== slot) return { ...state, open };
  return { ...state, open, focus: open[at] ?? open[at - 1] ?? null };
}

/** Puts nothing in front; the tabs stay. */
export const blur = (state: WorkspaceState): WorkspaceState => ({
  ...state,
  focus: null,
});

/** "Collapse all": every tab closed, nothing in front. */
export const closeAll = (state: WorkspaceState): WorkspaceState => ({
  ...state,
  open: [],
  focus: null,
});

export const setView = (
  state: WorkspaceState,
  view: WorkspaceView,
): WorkspaceState => ({ ...state, view });

/**
 * A link that lands on a project's Fleet with `slot` open and in front, as
 * Overview's "Needs you" rows deep-link (#213). A name that is not a slot's
 * opens the Fleet alone.
 */
export const slotHref = (projectId: string, slot: string): string =>
  `/projects/${projectId}/fleet${toSearch(openSlot(EMPTY_WORKSPACE, slot))}`;
