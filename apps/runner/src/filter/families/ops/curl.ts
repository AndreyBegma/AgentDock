import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import { cleanLines, hasFlag, joinLines } from './util';

/**
 * curl: the progress meter and, with `-v`, the TLS handshake and the request
 * headers. The response body is never shortened: an agent reads it to use it.
 */

const METER_HEADER = /^\s*% Total\s+% Received/;
const METER_COLUMNS = /^\s+Dload\s+Upload\s+Total/;
/** `100 1256  100 1256    0     0   3912      0 --:--:-- --:--:-- --:--:--  3925` */
const METER_ROW =
  /^\s*\d+\s+[\d.]+[kMGTP]?\s+\d+\s+[\d.]+[kMGTP]?\s+\d+\s+\d+\s+/;
const STREAM_DATA = /^[{}] \[\d+ bytes data\]$/;

/** The request headers worth keeping: the request line and the host. */
const REQUEST_KEEP = /^> (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) |^> Host: /i;
/** The response headers an agent acts on, besides the status line. */
const RESPONSE_KEEP =
  /^< (HTTP\/|content-type:|content-length:|location:|retry-after:|www-authenticate:|x-ratelimit)/i;

export const curlFilter: Filter = {
  id: 'ops/curl',
  matches: (argv) => argv[0] === 'curl',
  longRunning: (argv) =>
    hasFlag(argv, '-N', '--no-buffer') ||
    hasFlag(argv, '--continuous', '--stream'),
  apply: ({ argv, output }) => {
    const verbose = hasFlag(argv, '-v', '--verbose');
    const kept = cleanLines(output).filter((line) => {
      if (isProtectedLine(line)) return true;
      if (METER_HEADER.test(line) || METER_COLUMNS.test(line)) return false;
      if (METER_ROW.test(line)) return false;
      if (STREAM_DATA.test(line)) return false;
      if (!verbose) return true;
      if (line.startsWith('* ')) return false;
      if (line.startsWith('>')) return REQUEST_KEEP.test(line);
      if (line.startsWith('<')) return RESPONSE_KEEP.test(line);
      return true;
    });
    return joinLines(kept);
  },
};
