import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/**
 * Loads the server's environment file.
 *
 * `.env` is read when it exists, and `env.txt` is used when it does not.
 *
 * The second name exists because `.env` begins with a dot, and dot-files are hidden by default in
 * many file managers, unzip tools and panel file browsers. That makes a file which has to be edited
 * by hand awkward to even find, which is a silly thing to lose a deployment to. Either name works;
 * nothing about how the values are read changes.
 *
 * This must stay the FIRST import in server/_core/index.ts. Modules that read process.env while they
 * initialise - ./env notably - have to find the values already loaded, and import order is what
 * decides that.
 */
function resolveEnvFile(): string | null {
  const fromCwd = (name: string) => path.resolve(process.cwd(), name);
  const primary = fromCwd(".env");
  if (fs.existsSync(primary)) return primary;
  const fallback = fromCwd("env.txt");
  return fs.existsSync(fallback) ? fallback : null;
}

const envFile = resolveEnvFile();
if (envFile) {
  dotenv.config({ path: envFile });
}
