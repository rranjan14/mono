import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Map from name to packages/name
 */
export const internalPackagesMap: Map<string, string> = new Map();

const monoRootPath = fileURLToPath(new URL('../../../../', import.meta.url));

for (const p of ['packages']) {
  for (const f of fs.readdirSync(path.join(monoRootPath, p))) {
    const stat = fs.statSync(path.join(monoRootPath, p, f));
    if (stat.isDirectory()) {
      // Also ensure that there is a package.json in that directory
      const packageJSONPath = path.join(monoRootPath, p, f, 'package.json');

      if (fs.existsSync(packageJSONPath)) {
        const packageJSON = JSON.parse(
          fs.readFileSync(packageJSONPath, 'utf-8'),
        );
        if (packageJSON.private) {
          internalPackagesMap.set(f, `${p}/${f}`);
        }
      }
    }
  }
}

export const internalPackages = [...internalPackagesMap.keys()];

export function isInternalPackage(name: string): boolean {
  return internalPackagesMap.has(name);
}
