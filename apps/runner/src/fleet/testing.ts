import {
  eventSchema,
  type FleetEvent,
  parseFleetEvent,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { FakeClock } from '../testing/fake-clock';
import { type FleetProject, fleetEmitter } from './project';
import { SlotBook } from './slots';

/**
 * Collects what a fleet collector emits, and refuses — by throwing in the test
 * — any event the API would not parse: every emitted event goes through the
 * wire schema and `parseFleetEvent`, as the gateway and the projector do.
 */
export const recorder = () => {
  const raw: UnsequencedEvent[] = [];
  let seq = 0;
  const parsed = (): FleetEvent[] =>
    raw.map((event) => {
      const wire = eventSchema.parse({ ...event, seq: ++seq });
      const result = parseFleetEvent(wire);
      if (!result?.ok) {
        throw new Error(
          `${event.type} would be refused: ${result ? result.reason : 'not a fleet event'}`,
        );
      }
      return result.event;
    });
  return {
    raw,
    emit: (event: UnsequencedEvent) => raw.push(event),
    /** Every event so far, parsed; clears the list. */
    take(): FleetEvent[] {
      seq = 0;
      const events = parsed();
      raw.length = 0;
      return events;
    },
  };
};

/** A compact view of events for assertions: `type slot` plus the data. */
export const brief = (events: readonly FleetEvent[]) =>
  events.map((e) => ({
    type: e.type,
    ...(e.slot ? { slot: e.slot } : {}),
    data: e.data,
  }));

export const fleetProject = (
  overrides: Partial<FleetProject> = {},
): FleetProject => ({
  id: 'prj_1',
  root: '/srv/widget',
  github: 'acme/widget',
  repo: 'acme/widget',
  boardDir: '/srv/widget/.git/cs-orchestrator',
  sessionPrefix: null,
  defaultBase: 'origin/main',
  ...overrides,
});

/** A project, its slot book, a clock and an emitter wired to a recorder. */
export const fleetFixture = (overrides: Partial<FleetProject> = {}) => {
  const project = fleetProject(overrides);
  const clock = new FakeClock(Date.parse('2026-10-08T10:00:00.000Z'));
  const events = recorder();
  return {
    project,
    clock,
    events,
    book: new SlotBook(),
    emit: fleetEmitter(project, clock, events.emit),
    now: () => clock.now(),
  };
};
