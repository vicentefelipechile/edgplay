#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Use tsx to run the TypeScript CLI entry point
const { execFileSync } = require("node:child_process");
const { resolve, dirname } = require("node:path");
const { fileURLToPath } = require("node:url");

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "../src/index.ts");

execFileSync(
  process.execPath,
  ["--import", "tsx/esm", entry, ...process.argv.slice(2)],
  { stdio: "inherit" }
);
