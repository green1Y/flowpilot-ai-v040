import { execSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log("[migrate] Skipping: not a production deployment.");
  process.exit(0);
}

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
  throw new Error("Production DATABASE_URL is missing or is not PostgreSQL.");
}

execSync("npx prisma migrate deploy", { stdio: "inherit" });
