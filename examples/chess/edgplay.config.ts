/**
 * edgplay.config.ts — identity schema + CLI configuration for Chess.
 *
 * This file serves two purposes:
 *  1. The CLI reads `schema` to detect D1 drift and generate migrations
 *  2. The runtime uses `identitySchema` in createEngine().defineIdentity()
 *
 * Usage in src/index.ts:
 *   import { identitySchema } from "../edgplay.config.js";
 *   createEngine().defineIdentity(identitySchema)
 */

import { z } from "zod";
import { schemaToColumns } from "edgplay";

export const identitySchema = {
  public: z.object({
    name:   z.string().default("Anonymous"),
    avatar: z.string().url().optional(),
    level:  z.number().int().default(1),
  }),
  private: z.object({
    email: z.string().email().optional(),
    stats: z.object({
      wins:   z.number().int().default(0),
      losses: z.number().int().default(0),
      elo:    z.number().int().default(1000),
    }).default({ wins: 0, losses: 0, elo: 1000 }),
  }),
};

// Exported for the CLI — do not rename
export const schema = schemaToColumns(identitySchema);
