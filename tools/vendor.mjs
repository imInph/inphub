/**
 * inphub: copy the third-party browser libraries into public/assets/vendor/.
 *
 * The markdown renderer (markdown() in src/ui.ts) uses marked, its footnote
 * extension, and DOMPurify as plain globals, loaded by <script defer> tags in
 * server/Pages/Index.cshtml, the same way Chart.js is. The copies are committed so a
 * GitHub download runs with no Node and no CDN.
 *
 * Run after changing their versions in package.json:  npm install && npm run vendor
 * then update the file names in server/Pages/Index.cshtml (the version is in the name).
 */

import { copyFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'public/assets/vendor');

const libs = [
  { pkg: 'marked', file: 'lib/marked.umd.js', name: (v) => `marked-${v}.umd.js`, prefix: 'marked-' },
  { pkg: 'marked-footnote', file: 'dist/index.umd.js', name: (v) => `marked-footnote-${v}.umd.js`, prefix: 'marked-footnote-' },
  { pkg: 'dompurify', file: 'dist/purify.min.js', name: (v) => `purify-${v}.min.js`, prefix: 'purify-' },
];

for (const lib of libs) {
  const dir = join(root, 'node_modules', lib.pkg);
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const target = lib.name(version);

  // Drop older versions of the same library so the folder holds one of each.
  for (const existing of readdirSync(out)) {
    const sameLib = existing.startsWith(lib.prefix)
      && !(lib.pkg === 'marked' && existing.startsWith('marked-footnote-'));
    if (sameLib && existing !== target) unlinkSync(join(out, existing));
  }

  copyFileSync(join(dir, lib.file), join(out, target));
  console.log(`vendored ${lib.pkg} ${version} -> public/assets/vendor/${target}`);
}
