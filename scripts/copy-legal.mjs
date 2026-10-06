// prepack hook: npm only ships LICENSE/NOTICE that sit in the package folder.
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(path.join(root, file), path.join(process.cwd(), file));
