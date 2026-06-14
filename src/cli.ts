#!/usr/bin/env node
import { startServer } from './server.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === 'start') {
    await startServer();
  } else if (args[0] === '--version' || args[0] === '-v') {
    console.log('@idea404/repocontext 0.1.6');
  } else {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Usage: npx @idea404/repocontext [start]');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
