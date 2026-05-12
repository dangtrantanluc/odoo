import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Manual .env loader. OpenClaw plugins must not depend on dotenv-cli
 * because the gateway runs them with its own minimal env. We try, in
 * order: BROWSER_TOOLS_ENV → ~/.openclaw/plugins/browser-tools/.env →
 * source-dir .env. First file that exists wins.
 */

const PLUGIN_ID = "browser-tools";

function readEnvFile(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

// Eagerly load env at module-import time. JS hoists `import` statements,
// so calling loadEnv() from index.ts after the imports is too late — by
// then config.ts has already evaluated process.env. Importing this module
// (which we do first in index.ts) has the side effect of populating env.
let _loaded = false;

export function loadEnv(): void {
  const candidates = [
    process.env.BROWSER_TOOLS_ENV,
    path.join(os.homedir(), ".openclaw", "plugins", PLUGIN_ID, ".env"),
    path.join(__dirname, "..", ".env"),
  ].filter(Boolean) as string[];

  if (_loaded) return;
  _loaded = true;
  for (const p of candidates) {
    const parsed = readEnvFile(p);
    if (Object.keys(parsed).length > 0) {
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      console.log(`[browser-tools] loaded env from ${p} (${Object.keys(parsed).length} keys)`);
      return;
    }
  }
  console.warn(`[browser-tools] no .env found in candidates: ${candidates.join(", ")}`);
}

// Side-effect: load on first import. Place this AFTER loadEnv definition.
loadEnv();
