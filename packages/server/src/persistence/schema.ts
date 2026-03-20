/**
 * schema.ts — converts a defineIdentity() schema into SQL column definitions.
 *
 * Supports two input formats:
 *   1. Plain strings:  { name: "string", chips: "number", active: "boolean" }
 *   2. Zod schemas:    z.object({ name: z.string(), chips: z.number().int() })
 *
 * Output: an array of ColumnDef objects that the CLI uses to generate SQL.
 */

// ─── Column definition (internal representation) ──────────────────────────────

export interface ColumnDef {
  name: string;          // e.g. "public_name", "private_chips"
  sqlType: string;       // TEXT | INTEGER | REAL
  nullable: boolean;     // true → no NOT NULL constraint
  defaultValue?: string; // SQL literal e.g. "'player'", "100", "0"
  check?: string;        // SQL CHECK expression e.g. "length(col) <= 255"
}

// ─── Plain string schema ──────────────────────────────────────────────────────

type PlainSchema = Record<string, "string" | "number" | "boolean" | "json">;

function plainToColumns(prefix: string, schema: PlainSchema): ColumnDef[] {
  return Object.entries(schema).map(([key, type]) => {
    const name = `${prefix}_${key}`;
    switch (type) {
      case "string":  return { name, sqlType: "TEXT",    nullable: true };
      case "number":  return { name, sqlType: "REAL",    nullable: true };
      case "boolean": return { name, sqlType: "INTEGER", nullable: true };
      case "json":    return { name, sqlType: "TEXT",    nullable: true };
      default:        return { name, sqlType: "TEXT",    nullable: true };
    }
  });
}

// ─── Zod schema introspection ─────────────────────────────────────────────────
// We introspect Zod's internal _def structure instead of importing Zod types,
// so the CLI works without Zod being a hard dependency.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodDef = Record<string, any>;

function isZodType(v: unknown): v is { _def: ZodDef } {
  return typeof v === "object" && v !== null && "_def" in v;
}

function zodToColumn(prefix: string, key: string, zodType: { _def: ZodDef }): ColumnDef {
  const name = `${prefix}_${key}`;
  return resolveZodType(name, zodType._def, false);
}

function resolveZodType(name: string, def: ZodDef, isOptional: boolean): ColumnDef {
  const typeName: string = def.typeName ?? "";

  switch (typeName) {
    case "ZodOptional":
      return resolveZodType(name, def.innerType._def, true);

    case "ZodDefault": {
      const inner = resolveZodType(name, def.innerType._def, isOptional);
      const rawDefault = def.defaultValue?.();
      inner.defaultValue = toSqlLiteral(rawDefault);
      inner.nullable = false; // has a default → NOT NULL
      return inner;
    }

    case "ZodString": {
      const col: ColumnDef = { name, sqlType: "TEXT", nullable: isOptional };
      // z.string().max(n) → CHECK(length(col) <= n)
      const maxLen = def.checks?.find((c: ZodDef) => c.kind === "max")?.value;
      if (maxLen !== undefined) col.check = `length(${name}) <= ${maxLen}`;
      return col;
    }

    case "ZodNumber": {
      const isInt = def.checks?.some((c: ZodDef) => c.kind === "int");
      const col: ColumnDef = {
        name,
        sqlType: isInt ? "INTEGER" : "REAL",
        nullable: isOptional,
      };
      const minVal = def.checks?.find((c: ZodDef) => c.kind === "min")?.value;
      if (minVal !== undefined) col.check = `${name} >= ${minVal}`;
      return col;
    }

    case "ZodBoolean":
      return { name, sqlType: "INTEGER", nullable: isOptional };

    case "ZodEnum": {
      const values: string[] = def.values ?? [];
      const check = `${name} IN (${values.map(v => `'${v}'`).join(", ")})`;
      return { name, sqlType: "TEXT", nullable: isOptional, check };
    }

    case "ZodObject":
    case "ZodArray":
      // Nested objects / arrays → JSON blob
      return { name, sqlType: "TEXT", nullable: isOptional };

    case "ZodNullable": {
      const inner = resolveZodType(name, def.innerType._def, true);
      inner.nullable = true;
      return inner;
    }

    default:
      return { name, sqlType: "TEXT", nullable: isOptional };
  }
}

function toSqlLiteral(value: unknown): string {
  if (typeof value === "string")  return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number")  return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value === null)             return "NULL";
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function zodObjectToColumns(prefix: string, zodObject: { _def: ZodDef }): ColumnDef[] {
  const shape: Record<string, { _def: ZodDef }> = zodObject._def.shape?.() ?? {};
  return Object.entries(shape).map(([key, type]) => zodToColumn(prefix, key, type));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface IdentitySchema {
  public:  unknown;
  private: unknown;
}

/**
 * Convert a defineIdentity() schema into an array of SQL column definitions.
 * Handles both plain string schemas and Zod object schemas.
 */
export function schemaToColumns(schema: IdentitySchema): ColumnDef[] {
  const cols: ColumnDef[] = [];

  for (const scope of ["public", "private"] as const) {
    const s = schema[scope];
    if (!s) continue;

    if (isZodType(s)) {
      cols.push(...zodObjectToColumns(scope, s));
    } else if (typeof s === "object" && s !== null) {
      cols.push(...plainToColumns(scope, s as PlainSchema));
    }
  }

  return cols;
}

/**
 * Render a ColumnDef into a SQL column definition string for ALTER TABLE / CREATE TABLE.
 *
 * @example
 * columnToSql({ name: "public_level", sqlType: "INTEGER", nullable: false, defaultValue: "1" })
 * → "public_level INTEGER NOT NULL DEFAULT 1"
 */
export function columnToSql(col: ColumnDef): string {
  let sql = `${col.name} ${col.sqlType}`;
  if (!col.nullable) sql += " NOT NULL";
  if (col.defaultValue !== undefined) sql += ` DEFAULT ${col.defaultValue}`;
  if (col.check) sql += ` CHECK(${col.check})`;
  return sql;
}
