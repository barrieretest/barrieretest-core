#!/usr/bin/env node
import { parseArgs, runCli } from "./index.js";

const args = process.argv.slice(2);
const parsed = parseArgs(args);

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
