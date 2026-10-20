import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponsiveRows } from './responsive-rows';

interface Row {
  id: string;
  name: string;
  runs: number;
}

const rows: Row[] = [{ id: 'a', name: 'Alpha', runs: 3 }];
const columns = [
  { id: 'name', header: 'Name', cell: (r: Row) => r.name },
  { id: 'runs', header: 'Runs', cell: (r: Row) => r.runs },
];

describe('ResponsiveRows', () => {
  test('draws the table for tablet up and a stacked list for a phone', () => {
    const html = renderToStaticMarkup(
      <ResponsiveRows
        label="Things"
        rows={rows}
        getRowId={(r) => r.id}
        columns={columns}
      />,
    );
    expect(html).toContain('max-tablet:hidden');
    expect(html).toContain('aria-label="Things"');
    expect(html).toContain('<dt class="text-ink-3">Runs</dt>');
  });

  test('uses the caller’s phone row when given', () => {
    const html = renderToStaticMarkup(
      <ResponsiveRows
        label="Things"
        rows={rows}
        getRowId={(r) => r.id}
        columns={columns}
        stacked={(r) => <b>custom {r.name}</b>}
      />,
    );
    expect(html).toContain('<b>custom Alpha</b>');
  });
});
