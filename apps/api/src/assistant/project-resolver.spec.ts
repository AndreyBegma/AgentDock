import { projectsNamedIn } from './project-resolver';

const projects = [
  { id: 'a', displayName: 'AgentDock', repo: 'acme/agentdock' },
  { id: 'b', displayName: 'Billing API', repo: 'acme/billing-api' },
  { id: 'c', displayName: 'billing-web', repo: 'acme/billing-web' },
];

const ids = (message: string) =>
  projectsNamedIn(message, projects).map((p) => p.id);

describe('projectsNamedIn', () => {
  it('matches a display name or a repository name as a whole word', () => {
    expect(ids('What is holding up the AgentDock queue?')).toEqual(['a']);
    expect(ids('Что с очередью в billing-api?')).toEqual(['b']);
    expect(ids('look at acme/billing-web')).toEqual(['c']);
  });

  it('matches nothing inside a longer word', () => {
    expect(ids('agentdockish things')).toEqual([]);
    expect(ids('billing-apis')).toEqual([]);
  });

  it('takes the first word of a name when no full name is given', () => {
    expect(ids('how is the billing project doing?')).toEqual(['b', 'c']);
    expect(ids('billing-api and the billing thing')).toEqual(['b']);
  });

  it('returns every project a message names', () => {
    expect(ids('compare billing-api and billing-web')).toEqual(['b', 'c']);
  });
});
