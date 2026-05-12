import * as fs from "fs";
import * as path from "path";

/**
 * Load plugin env from one of:
 *   1. BB_PM_TOOLS_ENV (explicit path)
 *   2. ~/.openclaw/plugins/bb-pm-tools/.env (preferred prod path)
 *   3. <plugin source>/.env (co-located with the plugin)
 *
 * We parse by hand instead of importing dotenv so this plugin has zero
 * extra runtime deps and no DEP_0169 warnings from dotenv internals.
 * Values already present in process.env are NOT overwritten — env wins.
 */
const candidates = [
  process.env.BB_PM_TOOLS_ENV,
  path.join(process.env.HOME || "/root", ".openclaw/plugins/bb-pm-tools/.env"),
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, "..", "..", ".env"),
].filter(Boolean) as string[];

for (const file of candidates) {
  if (!file || !fs.existsSync(file)) continue;
  try {
    const content = fs.readFileSync(file, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip wrapping quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!key || key in process.env) continue;
      process.env[key] = val;
    }
    console.log(`[bb-pm-tools] loaded env from ${file}`);
    break;
  } catch (err: any) {
    console.warn(`[bb-pm-tools] failed to read env ${file}: ${err?.message || err}`);
  }
}
