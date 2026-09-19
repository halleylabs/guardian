// Jev client: typed judgments with a hard budget cap and a usage ledger.
// Falls back to a deterministic stub when TYPESAFE_API_KEY is absent.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'out');
const LEDGER = path.join(OUT, 'jev-ledger.json');
const PRICE_PER_MTOK = 0.042;
const BUDGET_USD = Number(process.env.JEV_BUDGET_USD ?? 4.0);

(function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!process.env.TYPESAFE_API_KEY && existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
})();

function ledger() {
  if (!existsSync(LEDGER)) return { input_tokens: 0, requests: 0, usd: 0 };
  return JSON.parse(readFileSync(LEDGER, 'utf8'));
}
function saveLedger(l) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

export const live = () => Boolean(process.env.TYPESAFE_API_KEY);
export const spend = () => ledger();

let LEDGER_MEM = null;
export async function judge(state, questions, { model = 'jev-latest' } = {}) {
  if (!live()) return stubJudge(state, questions);
  if (!LEDGER_MEM) LEDGER_MEM = ledger();
  const l = LEDGER_MEM;
  if (l.usd >= BUDGET_USD) {
    throw new Error(`Jev budget cap: spent $${l.usd.toFixed(4)} of $${BUDGET_USD} — refusing call`);
  }
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, state, questions }),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  l.input_tokens += data.usage?.input_tokens ?? 0;
  l.requests += 1;
  l.usd = (l.input_tokens / 1e6) * PRICE_PER_MTOK;
  saveLedger(l);
  return data.answers;
}

// Deterministic pseudo-judge so the sim runs end-to-end with no key.
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function stubJudge(state, questions) {
  const base = JSON.stringify(state);
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: hash01(base + id) };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const w = keys.map((k) => hash01(base + id + k) + 0.1);
      const total = w.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, w[i] / total]));
      const best = keys[w.indexOf(Math.max(...w))];
      answers[id] = { type: 'choice', choice: best, probabilities, confidence: Math.max(...w) / total };
    } else if (q.type === 'score') {
      const n = q.criteria.length;
      const idx = Math.min(n - 1, Math.floor(hash01(base + id) * n));
      answers[id] = { type: 'score', score: idx, probabilities: {}, confidence: 0.5 };
    }
  }
  return answers;
}
