import { config } from 'zod';

// Next runs this before any app code. Zod probes `new Function` once to pick
// its fast object parser; the CSP (F-27) has no 'unsafe-eval', so the probe —
// though caught — is reported as a violation. Jitless skips the probe and
// parses the same.
config({ jitless: true });
