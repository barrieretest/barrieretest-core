#!/usr/bin/env node
import { type ParsedArgs, parseArgs, runCli } from "./index.js";

const args = process.argv.slice(2);

let parsed: ParsedArgs;
try {
  parsed = parseArgs(args);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

runCli(parsed)
  .then((result) => {
    if (result.message) {
      console.log(result.message);
    }
    if (result.error) {
      console.error(`Error: ${result.error}`);
    }
    process.exit(result.exitCode ?? (result.success ? 0 : 1));
  })
  .catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
