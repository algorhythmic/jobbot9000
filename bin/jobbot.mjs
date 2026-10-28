#!/usr/bin/env node
// Build explicitly; never install dependencies, start services or enable transport.
try {
  const { main } = await import('../dist/cli.js');
  process.exitCode = await main();
} catch {
  process.stderr.write('JobBot command unavailable. Run npm run build with installed dependencies.\n');
  process.exitCode = 1;
}
