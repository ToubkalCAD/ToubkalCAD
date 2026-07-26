import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareCommonJsOutput(outputDirectory) {
  writeFileSync(
    path.join(outputDirectory, 'package.json'),
    `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  );
}

export function importCompiledModule(outputDirectory, relativePath) {
  return import(pathToFileURL(path.join(outputDirectory, relativePath)).href);
}
