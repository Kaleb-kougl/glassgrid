// Writes (or, with --check, verifies) every file generated from build-tokens.js.
//
//   pnpm --filter @glassgrid/ui tokens          regenerate
//   pnpm --filter @glassgrid/ui tokens --check  exit 1 if any output drifted
//
// build-tokens.js is the single source of truth; never edit the outputs.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildTokens } = require('./build-tokens.js');

/** File name -> generated content. JSON is two-space indented with no trailing newline. */
function tokenOutputs() {
  const out = buildTokens();
  const json = (value) => JSON.stringify(value, null, 2);
  return {
    'glassgrid.css': out.css,
    'glassgrid.tokens.json': json(out.dtcg),
    'glassgrid.resolved.light.json': json(out.resolved.light),
    'glassgrid.resolved.dark.json': json(out.resolved.dark),
    'checks.json': json(out.checks),
  };
}

/** Names of outputs whose file differs from what build-tokens.js produces now. */
function driftedOutputs(dir = __dirname) {
  return Object.entries(tokenOutputs())
    .filter(([name, content]) => {
      try {
        return readFileSync(join(dir, name), 'utf8') !== content;
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

function main(argv) {
  if (argv.includes('--check')) {
    const drifted = driftedOutputs();
    if (drifted.length > 0) {
      console.error(`Token outputs are out of date: ${drifted.join(', ')}. Run \`pnpm --filter @glassgrid/ui tokens\`.`);
      process.exitCode = 1;
    } else {
      console.info('Token outputs are up to date.');
    }
    return;
  }
  for (const [name, content] of Object.entries(tokenOutputs())) {
    writeFileSync(join(__dirname, name), content);
  }
  console.info(`Wrote ${Object.keys(tokenOutputs()).length} token files to ${__dirname}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { tokenOutputs, driftedOutputs };
