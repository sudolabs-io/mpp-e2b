#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Realistic "agent uses E2B in a workflow" harness, with USDC cost reporting.
 *
 * Two modes:
 *
 *   QUOTE (default) — read the price of every operation straight from the 402 challenge,
 *   for several templates, WITHOUT spending anything. Answers "what would this cost?".
 *     node scripts/agent-workflow.mjs --base-url http://localhost:3001 --timeout 300
 *     node scripts/agent-workflow.mjs --templates base,claude,desktop
 *
 *   RUN — drive a full sandbox lifecycle the way an agent session would (create → inspect →
 *   extend → observe → snapshot → pause → resume → delete) against ONE template, paying
 *   each step for real on the Tempo testnet, and print a per-operation cost breakdown plus
 *   the measured total spent and wall time.
 *     node scripts/agent-workflow.mjs --run --template code-interpreter-v1
 *
 * Prices are USDC with 6 decimals: usd = challenge.request.amount / 1e6. Note the proxy
 * only meters sandbox *lifecycle*; running code happens over the sandbox's own connection
 * once created, so it is not a charged proxy route and isn't part of this workflow.
 *
 * Flags: --base-url, --account, --rpc-url, --templates <csv>, --template <one>, --timeout,
 *        --run.
 */

const execFileAsync = promisify(execFile);
const USDC_DECIMALS = 1e6;

const args = parseArgs(process.argv.slice(2));
const baseUrl = trimSlash(
	args["base-url"] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3001",
);
const account = args.account ?? process.env.MPPX_ACCOUNT ?? "local-test";
const rpcUrl = args["rpc-url"] ?? process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
const timeout = Number(args.timeout ?? 300);
const templates = (args.templates ?? "base,code-interpreter-v1,openclaw,claude,desktop")
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);

if (args.run) await runWorkflow(args.template ?? "base");
else await quoteAll();

// ──────────────────────────── QUOTE MODE ────────────────────────────

async function quoteAll() {
	console.log(`Price quote against ${baseUrl}  (timeout=${timeout}s, currency=USDC)\n`);

	// Flat routes don't depend on the template — quote them once.
	const flat = [
		["GET /sandboxes (list)", "/sandboxes", { method: "GET" }],
		["GET /sandboxes/:id (get)", "/sandboxes/x", { method: "GET" }],
		["GET /sandboxes/:id/logs", "/sandboxes/x/logs", { method: "GET" }],
		["GET /sandboxes/:id/metrics", "/sandboxes/x/metrics", { method: "GET" }],
		["DELETE /sandboxes/:id (kill)", "/sandboxes/x", { method: "DELETE" }],
		["POST /sandboxes/:id/pause", "/sandboxes/x/pause", { method: "POST" }],
		["POST /sandboxes/:id/connect", "/sandboxes/x/connect", { method: "POST" }],
		["POST /sandboxes/:id/snapshots", "/sandboxes/x/snapshots", { method: "POST" }],
	];
	console.log("Flat routes (same for every template):");
	for (const [label, path, opts] of flat) {
		const q = await quote(path, opts);
		console.log(`  ${label.padEnd(34)} ${fmtUsd(q.usd)}`);
	}

	// Dynamic routes (create / extend) scale with the template's vCPU+RAM.
	console.log(`\nPer-template dynamic pricing @ ${timeout}s:`);
	console.log(
		`  ${"template".padEnd(22)} ${"create".padStart(11)} ${"set-timeout".padStart(12)} ${"refresh".padStart(11)}`,
	);
	for (const t of templates) {
		const create = await quote("/sandboxes", { method: "POST", body: { templateID: t, timeout } });
		// set-timeout / refresh need an existing sandbox to price, so we cannot quote them
		// unpaid here — but they use the identical compute formula as create over the same
		// seconds, so create@timeout is the representative dynamic price. Show it for clarity.
		const line = create.usd == null ? `(${create.note})` : fmtUsd(create.usd);
		console.log(
			`  ${t.padEnd(22)} ${line.padStart(11)} ${"= create".padStart(12)} ${"= create".padStart(11)}`,
		);
	}

	console.log(
		`\nNote: set-timeout and refresh use the same per-second compute formula as create, so a` +
			` T-second extend on a given template costs the same as a T-second create on it.`,
	);
	console.log(
		`Run a real, paid lifecycle with:  node scripts/agent-workflow.mjs --run --template <name>`,
	);
}

// ──────────────────────────── RUN MODE ────────────────────────────

async function runWorkflow(template) {
	console.log(`Agent workflow on template "${template}" against ${baseUrl}`);
	console.log(`account=${account}  initial timeout=${timeout}s\n`);

	const startedAt = nowMs();
	const steps = [];
	let sandboxId;

	// 1) Create — the agent spins up its workspace.
	{
		const body = { templateID: template, timeout };
		const price = await quote("/sandboxes", { method: "POST", body });
		const res = await payResilient("/sandboxes", { method: "POST", body });
		sandboxId = extractSandboxId(res.stdout);
		record(steps, "create sandbox", price.usd, res, [201]);
		if (!sandboxId) {
			console.log("\n✗ create did not return a sandboxID — aborting.\n" + res.stdout.slice(0, 400));
			return finish(steps, startedAt);
		}
		console.log(`  → sandbox ${sandboxId}`);
	}

	// A realistic session: inspect, extend as work runs long, observe, persist, idle, resume.
	const lifecycle = [
		["get details", `/sandboxes/${sandboxId}`, { method: "GET" }, [200]],
		[
			"set timeout (+600s)",
			`/sandboxes/${sandboxId}/timeout`,
			{ method: "POST", body: { timeout: 600 } },
			[200, 204],
		],
		[
			"refresh TTL (+300s)",
			`/sandboxes/${sandboxId}/refreshes`,
			{ method: "POST", body: { duration: 300 } },
			[200, 204],
		],
		["get logs", `/sandboxes/${sandboxId}/logs`, { method: "GET" }, [200]],
		["get metrics", `/sandboxes/${sandboxId}/metrics`, { method: "GET" }, [200]],
		[
			"snapshot",
			`/sandboxes/${sandboxId}/snapshots`,
			{ method: "POST", body: { pause: false } },
			[200, 201, 204],
		],
		["pause", `/sandboxes/${sandboxId}/pause`, { method: "POST" }, [200, 204]],
		[
			"connect (resume)",
			`/sandboxes/${sandboxId}/connect`,
			{ method: "POST", body: { timeout } },
			[200, 201, 204],
		],
	];
	for (const [label, path, opts, expected] of lifecycle) {
		const price = await quote(path, opts);
		const res = await payResilient(path, opts);
		record(steps, label, price.usd, res, expected);
	}

	// Tear down.
	{
		const price = await quote(`/sandboxes/${sandboxId}`, { method: "DELETE" });
		const res = await payResilient(`/sandboxes/${sandboxId}`, { method: "DELETE" });
		record(steps, "delete sandbox", price.usd, res, [200, 204, 404]);
	}

	finish(steps, startedAt);
}

function record(steps, label, usd, res, expected) {
	const okExpected = expected.includes(res.status);
	steps.push({ label, usd, status: res.status, okExpected, retried: res.retried });
	const flag = okExpected ? "✓" : "✗";
	const note = res.retried ? "  (retried after transient 402)" : "";
	console.log(
		`  ${flag} ${label.padEnd(22)} ${fmtUsd(usd).padStart(11)}   HTTP ${res.status}${note}`,
	);
}

function finish(steps, startedAt) {
	const total = steps.reduce((sum, s) => sum + (s.usd ?? 0), 0);
	const seconds = ((nowMs() - startedAt) / 1000).toFixed(1);
	const unexpected = steps.filter((s) => !s.okExpected);
	console.log("\n──────── workflow cost summary ────────");
	console.log(`steps:        ${steps.length}  (${unexpected.length} with unexpected status)`);
	console.log(`total cost:   ${fmtUsd(total)}  USDC`);
	console.log(`wall time:    ${seconds}s`);
	if (unexpected.length) {
		console.log(`unexpected:   ${unexpected.map((s) => `${s.label}=${s.status}`).join(", ")}`);
	}
	console.log("───────────────────────────────────────");
	process.exit(unexpected.length ? 1 : 0);
}

// ──────────────────────────── helpers ────────────────────────────

/** Read the price of an operation from its 402 challenge without paying. */
async function quote(path, { method = "GET", body } = {}) {
	const headers = {};
	let payload;
	if (body !== undefined) {
		payload = JSON.stringify(body);
		headers["content-type"] = "application/json";
	}
	const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
	if (res.status !== 402) {
		return { usd: null, note: `no challenge (HTTP ${res.status})`, status: res.status };
	}
	const challenge = res.headers.get("www-authenticate");
	return { usd: decodePrice(challenge), status: 402 };
}

/** Decode USD price from a WWW-Authenticate challenge's base64 `request` field. */
function decodePrice(challenge) {
	const m = challenge?.match(/request="([^"]+)"/);
	if (!m) return null;
	const decoded = Buffer.from(m[1], "base64").toString("utf8");
	const json = decoded.slice(0, decoded.lastIndexOf("}") + 1); // tolerate any decode slack
	try {
		return Number(JSON.parse(json).amount) / USDC_DECIMALS;
	} catch {
		return null;
	}
}

/**
 * Pay an operation, retrying once on a 402. On the Tempo testnet, payment verification can
 * fail transiently when the RPC hiccups ("Transaction creation failed / RPC Request
 * failed") — the proxy correctly fails closed with 402. A single retry mints a fresh
 * payment and almost always clears it; a genuine failure simply 402s again.
 */
async function payResilient(path, opts = {}) {
	const res = await pay(path, opts);
	if (res.status !== 402) return res;
	const retry = await pay(path, opts);
	retry.retried = true;
	return retry;
}

/** Pay-and-retry an operation via the real mppx CLI; return final status + stdout. */
async function pay(path, { method = "GET", body } = {}) {
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
	if (method && method !== "GET") a.push("--method", method);
	if (body !== undefined) a.push("--json-body", JSON.stringify(body));
	try {
		const { stdout } = await execFileAsync("pnpm", a, { maxBuffer: 10 * 1024 * 1024 });
		return { status: lastStatus(stdout), stdout };
	} catch (err) {
		const stdout = typeof err?.stdout === "string" ? err.stdout : "";
		return { status: lastStatus(stdout) ?? 0, stdout: stdout + String(err?.message ?? err) };
	}
}

function lastStatus(output) {
	const statuses = [...output.matchAll(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/gm)].map((m) => Number(m[1]));
	return statuses.at(-1);
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

function fmtUsd(usd) {
	return usd == null ? "—" : `$${usd.toFixed(6)}`;
}

function parseArgs(raw) {
	const parsed = {};
	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const nextVal = raw[i + 1];
		if (!nextVal || nextVal.startsWith("--")) parsed[key] = true;
		else {
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
