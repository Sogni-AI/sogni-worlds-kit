#!/usr/bin/env node
// `node world <command>` — every step of building a world. Run `node world help`.
import { main } from './cli/index.js';

main(process.argv.slice(2)).then(
  code => process.exit(code ?? 0),
  error => {
    console.error(`\n✗ ${error?.message ?? error}`);
    if (process.env.SOGNI_WORLD_DEBUG) console.error(error);
    process.exit(1);
  },
);
