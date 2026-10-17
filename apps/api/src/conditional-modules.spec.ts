import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * `ConditionalModule.registerWhen` starts a 5 s timer when its module file is
 * loaded, cleared only once `ConfigModule.forRoot` has run. A module that
 * calls it is imported by `AppModule` alone; loaded earlier — through a
 * feature module, a service or the module's barrel — it fails a slow boot
 * with "Nest was not able to resolve the config variables" (#302, #320, #584).
 */
const SRC = __dirname;
const APP_MODULE = join(SRC, 'app.module.ts');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });

/** Relative specifiers a file loads at runtime (`import type` is erased). */
const runtimeImports = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /^(?:import|export)\s+(?!type\s)[^;]*?from\s+'(\.[^']+)'/gms,
    ),
  ].map((match) => match[1]);

const resolveImport = (from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier);
  for (const path of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(path)) return path;
  }
  return null;
};

describe('modules that use ConditionalModule', () => {
  const files = sources(SRC);
  const conditional = files.filter((file) =>
    readFileSync(file, 'utf8').includes('ConditionalModule.registerWhen('),
  );
  // A barrel that re-exports a conditional module loads it as well.
  const barrels = files.filter(
    (file) =>
      file.endsWith('/index.ts') &&
      runtimeImports(file).some((specifier) =>
        conditional.includes(resolveImport(file, specifier) ?? ''),
      ),
  );
  const guarded = new Set([...conditional, ...barrels]);

  it('finds the modules it guards', () => {
    expect(conditional.length).toBeGreaterThan(0);
  });

  it('are loaded by AppModule alone', () => {
    const offenders = files
      .filter((file) => file !== APP_MODULE && !barrels.includes(file))
      .flatMap((file) =>
        runtimeImports(file)
          .filter((specifier) => {
            const target = resolveImport(file, specifier);
            return target !== null && target !== file && guarded.has(target);
          })
          .map((specifier) => `${relative(SRC, file)} → ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });
});
