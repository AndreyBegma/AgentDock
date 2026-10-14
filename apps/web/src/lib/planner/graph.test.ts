import { describe, expect, test } from 'bun:test';
import { plan, task } from './fixtures';
import { KIND_HUE } from './format';
import { nodeLabel, planGraph } from './graph';
import { planHref } from './href';

describe('planGraph', () => {
  test('tasks are nodes coloured by kind, toned by status', () => {
    const { nodes } = planGraph(plan());
    expect(nodes.map((n) => n.id)).toEqual(['t1', 't2', 't3']);
    const t2 = nodes[1];
    expect(t2?.hue).toBe(KIND_HUE.bug);
    expect(t2?.tone).toBe('blocked');
    expect(t2?.data.status).toBe('Needs talk');
    expect(KIND_HUE.bug).not.toBe(KIND_HUE.feature);
  });

  test('dependsOn becomes depends edges from dependency to dependant, once each', () => {
    const { edges } = planGraph(plan());
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      't1->t2',
      't1->t3',
      't2->t3',
    ]);
    expect(edges.every((e) => e.kind === 'depends')).toBe(true);
  });

  test('a dangling key or a self-loop draws no edge', () => {
    const p = plan({
      tasks: [task({ dependsOn: ['t1', 'gone'] })],
      graph: { nodes: [], edges: [{ from: 'x', to: 't1' }] },
    });
    expect(planGraph(p).edges).toEqual([]);
  });

  test('after sending, a node shows its live status', () => {
    const p = plan({
      tasks: [
        task({
          status: 'issued',
          issue: {
            number: 7,
            url: 'u',
            liveStatus: 'pr_open',
            prNumber: 8,
            prUrl: 'p',
          },
        }),
      ],
    });
    const [node] = planGraph(p).nodes;
    expect(node?.data.status).toBe('PR open');
    expect(node && nodeLabel(node)).toBe(
      'Feature t1: Planner contract, PR open',
    );
  });
});

describe('planHref', () => {
  test('the deep link /tasks uses', () => {
    expect(planHref('p1', 'plan-1', 't3')).toBe(
      '/projects/p1/planner/plan-1?task=t3',
    );
    expect(planHref('p1', 'plan-1')).toBe('/projects/p1/planner/plan-1');
  });
});
