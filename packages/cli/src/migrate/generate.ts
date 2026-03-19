/**
 * migrate:generate
 *
 * Compares the current identity schema (from edgplay config) against
 * the last known schema snapshot, detects drift, and writes a new
 * migration file to ./migrations/.
 *
 * Rename detection: if a field is dropped and another is added with
 * the same type, the CLI will prompt to confirm if it's a rename.
 *
 * TODO: implement
 */
export async function generate(_args: string[]): Promise<void> {
  console.log("migrate:generate — TODO");
}
