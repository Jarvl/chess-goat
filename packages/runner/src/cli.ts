// Replaced by tsup at build time with package.json's version.
declare const __VERSION__: string;

const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log(__VERSION__);
} else if (args.length === 0 || args[0] === '--help') {
  console.log('goat-runner <command>; commands arrive in later tasks');
} else {
  console.error(`Unknown command: ${args[0]}`);
  process.exitCode = 2;
}
