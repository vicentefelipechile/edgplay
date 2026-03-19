#!/usr/bin/env node
/**
 * npx edgplay <command>
 *
 * Commands:
 *   migrate:generate   Detect schema drift and generate migration files
 *   migrate:apply      Apply pending migrations to D1
 *   migrate:rollback   Revert last applied migration
 *   migrate:status     Show applied vs pending migrations
 */

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "migrate:generate": {
      const { generate } = await import("./migrate/generate.js");
      await generate(args);
      break;
    }
    case "migrate:apply": {
      const { apply } = await import("./migrate/apply.js");
      await apply(args);
      break;
    }
    case "migrate:rollback": {
      const { rollback } = await import("./migrate/rollback.js");
      await rollback(args);
      break;
    }
    case "migrate:status": {
      const { status } = await import("./migrate/status.js");
      await status(args);
      break;
    }
    default: {
      console.log(`
edgplay CLI

Usage:
  npx edgplay migrate:generate   Detect schema drift, generate migration files
  npx edgplay migrate:apply      Apply pending migrations to D1
  npx edgplay migrate:rollback   Revert last applied migration
  npx edgplay migrate:status     Show applied vs pending migrations
`);
      process.exit(command ? 1 : 0);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
