#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

/**
 * Soak / load harness for the paid request path and the Upstash replay store.
 *
 * Drives sustained paid traffic and watches for the things a short functional test can't
 * surface: error rate under load, latency drift, and replay-store keyspace growth (each
 * accepted payment writes one marker, so markers should grow ~1:1 with successful paid
 * ops and never more — a faster-than-1:1 climb would mean leakage).
 *
 * Every paid op shells out to the real `mppx` CLI (fresh payment, testnet settlement), so
 * this is inherently slow and costs faucet funds. Keep iteration counts modest.
 *
 *   node scripts/soak.mjs --base-url http://localhost:3001 --iterations 30 --concurrency 3
 *   node scripts/soak.mjs --base-url http://localhost:3001 --iterations 10 --lifecycle   # create→get→delete
 *
 * Flags: --base-url, --account, --rpc-url, --iterations, --concurrency, --lifecycle, --template
 */

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const baseUrl = trimSlash(
	args["base-url"] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3001",
);
const account = args.account ?? process.env.MPPX_ACCOUNT ?? "local-test";
const rpcUrl = args["rpc-url"] ?? process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
const iterations = Number(args.iterations ?? 30);
const concurrency = Number(args.concurrency ?? 3);
const lifecycle = Boolean(args.lifecycle);
const template = args.template ?? "base";

const upstash = loadUpstash();

console.log(`Soak: ${baseUrl}`);
console.log(
	`mode=${lifecycle ? "lifecycle (create→get→delete)" : "paid GET /sandboxes"} iterations=${iterations} concurrency=${concurrency} account=${account}`,
);
if (!upstash) console.log("(no Upstash creds found — keyspace growth will not be sampled)");

const samples = [];
const latencies = [];
let ok = 0;
let failed = 0;
const errors = [];

const startMarkers = await dbsize();
const startedAt = nowMs();

// Bounded worker pool: `concurrency` workers pull from a shared counter until the
// iteration budget is exhausted.
let next = 0;
async function worker() {
	while (true) {
		const i = next++;
		if (i >= iterations) return;
		const t0 = nowMs();
		try {
			if (lifecycle) await runLifecycle();
			else await runPaidGet();
			ok++;
		} catch (err) {
			failed++;
			errors.push(String(err?.message ?? err).split("\n")[0]);
		}
		latencies.push(nowMs() - t0);
		// Sample keyspace roughly every 10% of progress.
		if ((i + 1) % Math.max(1, Math.floor(iterations / 10)) === 0) {
			const markers = await dbsize();
			const elapsed = ((nowMs() - startedAt) / 1000).toFixed(1);
			samples.push({ done: ok + failed, markers, elapsed });
			console.log(
				`  ${ok + failed}/${iterations} done  ok=${ok} fail=${failed}  markers=${markers ?? "?"}  +${elapsed}s`,
			);
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const endMarkers = await dbsize();
const totalSeconds = (nowMs() - startedAt) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) =>
	latencies.length
		? Math.round(
				latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))],
			)
		: 0;

const paidOpsPerIter = lifecycle ? 3 : 1; // lifecycle settles 3 paid ops (create/get/delete)
const expectedMarkers = ok * paidOpsPerIter;

console.log("\n──────── soak report ────────");
console.log(`duration:        ${totalSeconds.toFixed(1)}s`);
console.log(`iterations:      ${ok} ok / ${failed} failed (of ${iterations})`);
console.log(`throughput:      ${(ok / totalSeconds).toFixed(2)} ok-iters/s`);
console.log(
	`latency (ms):    p50=${pct(50)} p95=${pct(95)} max=${pct(100)} min=${latencies[0] ?? 0}`,
);
if (startMarkers != null && endMarkers != null) {
	console.log(`replay markers:  ${startMarkers} → ${endMarkers} (Δ ${endMarkers - startMarkers})`);
	console.log(`expected Δ:      ~${expectedMarkers} (1 marker per successful paid op; TTL 3600s)`);
	const delta = endMarkers - startMarkers;
	if (delta > expectedMarkers) {
		console.log(
			`⚠ markers grew faster than paid ops (${delta} > ${expectedMarkers}) — investigate leakage.`,
		);
	} else {
		console.log(`✓ no faster-than-1:1 marker growth (no per-op leakage).`);
		console.log(
			`  note: long-term keyspace is bounded by the 3600s TTL, which a short run does not exercise.`,
		);
	}
}
if (errors.length) {
	console.log(`\nfirst errors:`);
	for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
}
console.log("─────────────────────────────");

process.exit(failed > 0 ? 1 : 0);

// ---- helpers ----

async function runPaidGet() {
	const { status } = await mppx(`/sandboxes`);
	if (status !== 200) throw new Error(`GET /sandboxes returned ${status}`);
}

async function runLifecycle() {
	const create = await mppx(`/sandboxes`, {
		method: "POST",
		body: { templateID: template, timeout: 60 },
	});
	if (create.status !== 201) throw new Error(`create returned ${create.status}`);
	const id = extractSandboxId(create.stdout);
	if (!id) throw new Error("no sandboxID in create response");
	const get = await mppx(`/sandboxes/${id}`);
	if (get.status !== 200) throw new Error(`get returned ${get.status}`);
	const del = await mppx(`/sandboxes/${id}`, { method: "DELETE" });
	if (![200, 204].includes(del.status)) throw new Error(`delete returned ${del.status}`);
}

async function mppx(path, opts = {}) {
	const a = [
		"exec",
		"mppx",
		`${baseUrl}${path}`,
		"--account",
		account,
		"--rpc-url",
		rpcUrl,
		"--insecure",
		"--include",
	];
	if (opts.method && opts.method !== "GET") a.push("--method", opts.method);
	if (opts.body !== undefined) a.push("--json-body", JSON.stringify(opts.body));
	const { stdout } = await execFileAsync("pnpm", a, { maxBuffer: 10 * 1024 * 1024 });
	const statuses = [...stdout.matchAll(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/gm)].map((m) => Number(m[1]));
	return { status: statuses.at(-1), stdout };
}

async function dbsize() {
	if (!upstash) return null;
	try {
		const res = await fetch(`${upstash.url}/dbsize`, {
			headers: { Authorization: `Bearer ${upstash.token}` },
		});
		const json = await res.json();
		return Number(json.result);
	} catch {
		return null;
	}
}

function loadUpstash() {
	let url = process.env.UPSTASH_REDIS_REST_URL;
	let token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		try {
			const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
			for (const line of env.split("\n")) {
				const m = line.match(/^(UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN)=(.*)$/);
				if (!m) continue;
				const value = m[2].trim().replace(/^["']|["']$/g, "");
				if (m[1] === "UPSTASH_REDIS_REST_URL") url = value;
				else token = value;
			}
		} catch {
			/* no .env.local */
		}
	}
	return url && token ? { url: trimSlash(url), token } : null;
}

function extractSandboxId(output) {
	const match = output.match(/\{[^\n]*"sandboxID"[^\n]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]).sandboxID;
	} catch {
		return null;
	}
}

function parseArgs(raw) {
	const parsed = {};
	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const nextVal = raw[i + 1];
		if (!nextVal || nextVal.startsWith("--")) {
			parsed[key] = true;
		} else {
			parsed[key] = nextVal;
			i++;
		}
	}
	return parsed;
}

function trimSlash(v) {
	return v.replace(/\/+$/, "");
}

function nowMs() {
	return Number(process.hrtime.bigint() / 1_000_000n);
}
