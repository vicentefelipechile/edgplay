import { describe, it, expect } from "vitest";
import { schemaToColumns, columnToSql } from "../src/persistence/schema.js";

// ─── Plain string schema ──────────────────────────────────────────────────────

describe("plain string schema", () => {
  it("maps string → TEXT", () => {
    const cols = schemaToColumns({ public: { name: "string" }, private: {} });
    expect(cols[0]).toMatchObject({ name: "public_name", sqlType: "TEXT", nullable: true });
  });

  it("maps number → REAL", () => {
    const cols = schemaToColumns({ public: {}, private: { balance: "number" } });
    expect(cols[0]).toMatchObject({ name: "private_balance", sqlType: "REAL" });
  });

  it("maps boolean → INTEGER", () => {
    const cols = schemaToColumns({ public: { active: "boolean" }, private: {} });
    expect(cols[0]).toMatchObject({ name: "public_active", sqlType: "INTEGER" });
  });

  it("maps json → TEXT", () => {
    const cols = schemaToColumns({ public: {}, private: { stats: "json" } });
    expect(cols[0]).toMatchObject({ name: "private_stats", sqlType: "TEXT" });
  });

  it("prefixes public_ and private_ correctly", () => {
    const cols = schemaToColumns({
      public:  { name: "string" },
      private: { chips: "number" },
    });
    const names = cols.map(c => c.name);
    expect(names).toContain("public_name");
    expect(names).toContain("private_chips");
  });
});

// ─── Zod schema ───────────────────────────────────────────────────────────────

describe("Zod schema", () => {
  // We load Zod dynamically to avoid a hard dependency in tests
  async function z() {
    const { z } = await import("zod");
    return z;
  }

  it("z.string() → TEXT NOT NULL", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ name: zz.string() });
    const cols = schemaToColumns({ public: schema, private: {} });
    expect(cols[0]).toMatchObject({ name: "public_name", sqlType: "TEXT", nullable: false });
  });

  it("z.number().int() → INTEGER", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ level: zz.number().int() });
    const cols = schemaToColumns({ public: schema, private: {} });
    expect(cols[0]).toMatchObject({ name: "public_level", sqlType: "INTEGER" });
  });

  it("z.number() (no .int()) → REAL", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ score: zz.number() });
    const cols = schemaToColumns({ public: schema, private: {} });
    expect(cols[0]).toMatchObject({ name: "public_score", sqlType: "REAL" });
  });

  it("z.boolean() → INTEGER", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ active: zz.boolean() });
    const cols = schemaToColumns({ public: schema, private: {} });
    expect(cols[0]).toMatchObject({ name: "public_active", sqlType: "INTEGER" });
  });

  it("z.string().optional() → TEXT nullable", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ bio: zz.string().optional() });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0]).toMatchObject({ name: "private_bio", sqlType: "TEXT", nullable: true });
  });

  it("z.number().int().default(0) → INTEGER NOT NULL DEFAULT 0", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ wins: zz.number().int().default(0) });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0]).toMatchObject({
      name: "private_wins",
      sqlType: "INTEGER",
      nullable: false,
      defaultValue: "0",
    });
  });

  it("z.string().default('player') → TEXT NOT NULL DEFAULT 'player'", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ role: zz.string().default("player") });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0]).toMatchObject({
      name: "private_role",
      sqlType: "TEXT",
      nullable: false,
      defaultValue: "'player'",
    });
  });

  it("z.enum(['a','b']) → TEXT with CHECK constraint", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ role: zz.enum(["player", "vip", "mod"]) });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0]).toMatchObject({ name: "private_role", sqlType: "TEXT" });
    expect(cols[0].check).toContain("'player'");
    expect(cols[0].check).toContain("'vip'");
    expect(cols[0].check).toContain("'mod'");
  });

  it("z.enum().default() → NOT NULL with DEFAULT and CHECK", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ role: zz.enum(["player", "vip", "mod"]).default("player") });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0].nullable).toBe(false);
    expect(cols[0].defaultValue).toBe("'player'");
    expect(cols[0].check).toBeDefined();
  });

  it("z.string().max(500) → TEXT with CHECK(length <= 500)", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ bio: zz.string().max(500) });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0].check).toBe("length(private_bio) <= 500");
  });

  it("z.number().int().min(0) → INTEGER with CHECK(col >= 0)", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ chips: zz.number().int().min(0) });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0].check).toBe("private_chips >= 0");
  });

  it("z.object() (nested) → TEXT (JSON blob)", async () => {
    const { z: zz } = await import("zod");
    const schema = zz.object({ stats: zz.object({ wins: zz.number() }) });
    const cols = schemaToColumns({ public: {}, private: schema });
    expect(cols[0]).toMatchObject({ name: "private_stats", sqlType: "TEXT" });
  });
});

// ─── columnToSql ─────────────────────────────────────────────────────────────

describe("columnToSql", () => {
  it("basic nullable TEXT", () => {
    expect(columnToSql({ name: "public_name", sqlType: "TEXT", nullable: true }))
      .toBe("public_name TEXT");
  });

  it("NOT NULL INTEGER with DEFAULT", () => {
    expect(columnToSql({ name: "private_wins", sqlType: "INTEGER", nullable: false, defaultValue: "0" }))
      .toBe("private_wins INTEGER NOT NULL DEFAULT 0");
  });

  it("TEXT with CHECK constraint", () => {
    expect(columnToSql({
      name: "private_role",
      sqlType: "TEXT",
      nullable: false,
      defaultValue: "'player'",
      check: "private_role IN ('player','vip')",
    })).toBe("private_role TEXT NOT NULL DEFAULT 'player' CHECK(private_role IN ('player','vip'))");
  });

  it("nullable TEXT with max length check", () => {
    expect(columnToSql({
      name: "private_bio",
      sqlType: "TEXT",
      nullable: true,
      check: "length(private_bio) <= 500",
    })).toBe("private_bio TEXT CHECK(length(private_bio) <= 500)");
  });
});
