/**
 * inphub: stamp a build id onto every compiled ES-module import.
 *
 * Why this exists
 * ---------------
 * tsc emits bare relative specifiers: `import { toast } from './ui.js'`. Those
 * URLs carry no version, so index.php's ?v= cache-bust on app.js protects only
 * the entry point. A browser can then pair a freshly fetched app.js with a
 * cached ui.js from an earlier build, and a missing export is an ES-module
 * *link* error, which stops app.js from executing at all. The whole app dies
 * silently: no views, no shortcuts, no console output.
 *
 * Rewriting the specifiers to './ui.js?v=<build id>' makes every module a new
 * URL whenever any module changes, so the browser cannot mix builds. This works
 * regardless of server config, no .htaccess, no headers, nothing to forget on
 * the XAMPP laptop.
 *
 * Runs after tsc (see package.json "build"). Idempotent: existing stamps are
 * stripped before the id is recomputed, so repeated builds stay stable.
 *
 * The id is also written to build-id.txt, which index.php reads for the entry
 * <script> URL. That MUST match the id in the import specifiers: if the entry
 * is app.js?v=A while a module imports ./app.js?v=B, the browser treats them
 * as two different modules and evaluates app.js twice, the second copy runs
 * init() while command-palette.js is still mid-evaluation, which throws
 * "Cannot access 'chatEnabled' before initialization" and kills the palette.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dir = fileURLToPath(new URL('../public/assets/js/', import.meta.url));

/** Matches a relative module specifier in a quoted string, with any old stamp. */
const SPECIFIER = /(['"])(\.\/[A-Za-z0-9_.-]+\.js)(?:\?v=[0-9a-f]+)?\1/g;

// Defensive: anything named vendor-*.js is treated as a third-party bundle and
// never rewritten. Vendored files normally live in public/assets/vendor/, which
// this script does not touch at all, because assets/js/ is gitignored as
// compiled output and a vendored file has to ship with the repo.
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const ours = files.filter((f) => !f.startsWith('vendor-'));
if (ours.length === 0) {
  console.error('stamp-modules: no compiled JS found — did tsc run?');
  process.exit(1);
}

// Strip first, so the build id depends on content only, never on a prior stamp.
const bare = new Map();
for (const file of ours) {
  bare.set(file, readFileSync(join(dir, file), 'utf8').replace(SPECIFIER, '$1$2$1'));
}

const hash = createHash('sha256');
for (const file of [...files].sort()) {
  hash.update(file);
  hash.update(bare.get(file) ?? readFileSync(join(dir, file)));
}
const buildId = hash.digest('hex').slice(0, 10);

let rewritten = 0;
for (const file of ours) {
  const stamped = bare.get(file).replace(SPECIFIER, `$1$2?v=${buildId}$1`);
  writeFileSync(join(dir, file), stamped);
  if (stamped !== bare.get(file)) rewritten++;
}

// index.php reads this for the entry URL, so the whole graph shares one id.
writeFileSync(join(dir, 'build-id.txt'), buildId + '\n');

console.log(`stamped ${rewritten}/${ours.length} modules with ?v=${buildId}`
  + (files.length > ours.length ? ` (${files.length - ours.length} vendor file(s) left untouched)` : ''));
