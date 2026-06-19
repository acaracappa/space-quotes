// Thin REST client for the Orbit Sentinel API.
// Reads MCP_API_URL / MCP_API_KEY from the gitignored .env at repo root.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    throw new Error("Missing .env (MCP_API_URL, MCP_API_KEY) at repo root");
  }
  if (!env.MCP_API_URL || !env.MCP_API_KEY) throw new Error("MCP_API_URL / MCP_API_KEY not set in .env");
  return env;
}

const ENV = loadEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize requests with a minimum gap to stay under the rate limit.
const MIN_GAP_MS = 180;
let gate = Promise.resolve();
function throttle() {
  const turn = gate.then(() => sleep(MIN_GAP_MS));
  gate = turn;
  return turn;
}

// GET with retry/backoff on 429 (rate limit) and 503. Respects Retry-After when present.
async function fetchWithRetry(path, { retries = 5 } = {}) {
  const url = path.startsWith("http") ? path : `${ENV.MCP_API_URL}${path}`;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ENV.MCP_API_KEY}` } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const ra = parseFloat(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) ? ra * 1000 : Math.min(8000, 500 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    throw new Error(`GET ${path} -> ${res.status}`);
  }
}

export async function apiGet(path) {
  const res = await fetchWithRetry(path);
  return res.json();
}

export async function apiDownload(path) {
  const res = await fetchWithRetry(path);
  return Buffer.from(await res.arrayBuffer());
}

export { ENV };
