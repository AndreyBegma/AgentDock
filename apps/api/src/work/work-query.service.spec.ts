import { workSourceOfCard } from './work-query.service';

/** #388: the `source` a Work row reports for a board card. */
describe('workSourceOfCard', () => {
  it('reports a mirrored fleet slot as fleet, whatever its column', () => {
    expect(workSourceOfCard({ source: 'fleet', column: 'in_progress' })).toBe(
      'fleet',
    );
    expect(workSourceOfCard({ source: 'fleet', column: 'todo' })).toBe('fleet');
  });

  it('keeps person, terminal and planner cards as card', () => {
    for (const source of ['manual', 'terminal', 'captured']) {
      expect(workSourceOfCard({ source, column: 'todo' })).toBe('card');
    }
  });

  it('reports an Inbox suggestion as inbox', () => {
    expect(workSourceOfCard({ source: 'captured', column: 'inbox' })).toBe(
      'inbox',
    );
  });
});
