import { execSync } from "child_process";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

// Global setup: create a fresh test database and push the Prisma schema.
// Runs once per `vitest run` invocation, in a separate process.
export default async function globalSetup() {
  const dir = process.cwd(); // vitest runs from the project root
  const testDb = join(dir, "test.db");
  const journal = join(dir, "test.db-journal");
  if (existsSync(testDb)) unlinkSync(testDb);
  if (existsSync(journal)) unlinkSync(journal);

  execSync("npx prisma db push --accept-data-loss --skip-generate", {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "pipe",
  });
  console.log("[vitest] test database ready at ./test.db");

  return async () => {
    // teardown: leave test.db on disk for inspection; harmless.
  };
}
