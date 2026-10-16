import { describe, it } from 'bun:test';
import { join } from 'node:path';
import { loadCorpus, runCorpusCase, savingsMedian } from '../../corpus';
import { ALL_FILTERS } from '..';

// Prints the kept/raw ratio of every js corpus case: JS_CORPUS_REPORT=1 bun test <this file>
describe.skipIf(process.env.JS_CORPUS_REPORT !== '1')(
  'js corpus report',
  () => {
    it('prints', () => {
      const results = loadCorpus(join(import.meta.dir, 'corpus')).map((c) =>
        runCorpusCase(ALL_FILTERS, c),
      );
      for (const r of results) {
        console.log(
          `${r.case.name.padEnd(28)} ${String(r.filter).padEnd(14)} ${r.filtered ? 'filtered' : 'original'} ${r.ratio.toFixed(3)} missing=${r.missing.length} raw=${Buffer.byteLength(r.case.output)}`,
        );
      }
      console.log(
        `median failing=${savingsMedian(results, 'failing')} passing=${savingsMedian(results, 'passing')}`,
      );
    });
  },
);
