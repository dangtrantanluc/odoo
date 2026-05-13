import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

type StorageItem = { name: string; value: string };
type OriginState = { origin: string; localStorage: StorageItem[] };
type StorageState = {
  cookies?: Array<Record<string, unknown>>;
  origins?: OriginState[];
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function normalizeInput(raw: string): OriginState {
  const parsed = JSON.parse(raw.trim());
  const origin = String(parsed.origin || "https://gapowork.com");
  const items = Array.isArray(parsed.localStorage)
    ? parsed.localStorage
    : Object.entries(parsed).map(([name, value]) => ({ name, value }));
  return {
    origin,
    localStorage: items
      .filter((item: any) => item?.name && item?.value !== undefined)
      .map((item: any) => ({ name: String(item.name), value: String(item.value) })),
  };
}

async function main() {
  const inputPath = process.argv[2];
  const raw = inputPath ? fs.readFileSync(inputPath, "utf8") : await readStdin();
  const incoming = normalizeInput(raw);
  const target = config.browser.storageStatePath;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const state: StorageState = fs.existsSync(target)
    ? JSON.parse(fs.readFileSync(target, "utf8"))
    : { cookies: [], origins: [] };

  state.cookies ??= [];
  state.origins ??= [];

  const originsToWrite = new Set([
    incoming.origin,
    "https://gapowork.com",
    "https://www.gapowork.vn",
  ]);

  for (const origin of originsToWrite) {
    let current = state.origins.find((item) => item.origin === origin);
    if (!current) {
      current = { origin, localStorage: [] };
      state.origins.push(current);
    }
    const merged = new Map(current.localStorage.map((item) => [item.name, item.value]));
    for (const item of incoming.localStorage) merged.set(item.name, item.value);
    current.localStorage = [...merged].map(([name, value]) => ({ name, value }));
  }

  const backup = `${target}.bak-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
  if (fs.existsSync(target)) fs.copyFileSync(target, backup);
  fs.writeFileSync(target, JSON.stringify(state, null, 2) + "\n");
  console.log(`Imported ${incoming.localStorage.length} localStorage keys into ${target}`);
  if (fs.existsSync(backup)) console.log(`Backup: ${backup}`);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
