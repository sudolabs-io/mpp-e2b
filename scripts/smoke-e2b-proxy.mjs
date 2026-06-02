#!/usr/bin/env node
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const baseUrl = trimTrailingSlash(
	args["base-url"] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3001",
);
const account = args.account ?? process.env.MPPX_ACCOUNT ?? "local-test";
const rpcUrl = args["rpc-url"] ?? process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
const shouldCreate = Boolean(args.create || args.full);
const shouldRunFullLifecycle = Boolean(args.full);
const timeout = Number(args.timeout ?? 60);

const fakeSandboxId = "smoke-test-sandbox-id";
let createdSandboxId;

try {
	console.log(`Smoke testing ${baseUrl}`);
	console.log(`mppx account: ${account}`);
	console.log(`rpc url: ${rpcUrl}`);

	await expectFetch("GET /openapi.json", "/openapi.json", { expected: [200] });
	await assertOpenApiPaths();
	await expectFetch("GET /e2b/sandboxes is hidden", "/e2b/sandboxes", { expected: [404] });

	await expectFetch("GET /sandboxes challenge", "/sandboxes", { expected: [402] });
	await expectFetch("POST /sandboxes challenge", "/sandboxes", {
		expected: [402],
		method: "POST",
		body: { templateID: "base", timeout },
	});
	await expectFetch("GET /sandboxes/:id challenge", `/sandboxes/${fakeSandboxId}`, {
		expected: [402],
	});
	await expectFetch("DELETE /sandboxes/:id challenge", `/sandboxes/${fakeSandboxId}`, {
		expected: [402],
		method: "DELETE",
	});
	await expectFetch(
		"POST /sandboxes/:id/connect challenge",
		`/sandboxes/${fakeSandboxId}/connect`,
		{
			expected: [402],
			method: "POST",
		},
	);
	await expectFetch("POST /sandboxes/:id/pause challenge", `/sandboxes/${fakeSandboxId}/pause`, {
		expected: [402],
		method: "POST",
	});
	await expectFetch(
		"POST /sandboxes/:id/refreshes challenge",
		`/sandboxes/${fakeSandboxId}/refreshes`,
		{
			expected: [402],
			method: "POST",
			body: { duration: timeout },
		},
	);
	await expectFetch(
		"POST /sandboxes/:id/timeout challenge",
		`/sandboxes/${fakeSandboxId}/timeout`,
		{
			expected: [402],
			method: "POST",
			body: { timeout },
		},
	);
	await expectFetch(
		"POST /sandboxes/:id/snapshots challenge",
		`/sandboxes/${fakeSandboxId}/snapshots`,
		{
			expected: [402],
			method: "POST",
		},
	);
	await expectFetch("GET /sandboxes/:id/logs challenge", `/sandboxes/${fakeSandboxId}/logs`, {
		expected: [402],
	});
	await expectFetch("GET /v2/sandboxes/:id/logs challenge", `/v2/sandboxes/${fakeSandboxId}/logs`, {
		expected: [402],
	});
	await expectFetch("GET /sandboxes/:id/metrics challenge", `/sandboxes/${fakeSandboxId}/metrics`, {
		expected: [402],
	});

	await expectMppx("paid GET /sandboxes", "/sandboxes", { expected: [200] });

	if (shouldCreate) {
		const create = await expectMppx("paid POST /sandboxes", "/sandboxes", {
			expected: [201],
			method: "POST",
			body: { templateID: "base", timeout },
		});
		createdSandboxId = extractSandboxId(create.stdout);
		if (!createdSandboxId) throw new Error("Could not find sandboxID in create response.");
		console.log(`created sandbox: ${createdSandboxId}`);

		await expectMppx("paid GET /sandboxes/:id", `/sandboxes/${createdSandboxId}`, {
			expected: [200],
		});

		if (shouldRunFullLifecycle) {
			await expectMppx("paid GET /sandboxes/:id/logs", `/sandboxes/${createdSandboxId}/logs`, {
				expected: [200],
			});
			await expectMppx(
				"paid GET /v2/sandboxes/:id/logs",
				`/v2/sandboxes/${createdSandboxId}/logs`,
				{
					expected: [200],
				},
			);
			await expectMppx(
				"paid GET /sandboxes/:id/metrics",
				`/sandboxes/${createdSandboxId}/metrics`,
				{
					expected: [200],
				},
			);
			await expectMppx(
				"paid POST /sandboxes/:id/timeout",
				`/sandboxes/${createdSandboxId}/timeout`,
				{
					expected: [200, 204],
					method: "POST",
					body: { timeout },
				},
			);
			await expectMppx(
				"paid POST /sandboxes/:id/refreshes",
				`/sandboxes/${createdSandboxId}/refreshes`,
				{
					expected: [200, 204],
					method: "POST",
					body: { duration: timeout },
				},
			);
			await expectMppx("paid POST /sandboxes/:id/pause", `/sandboxes/${createdSandboxId}/pause`, {
				expected: [200, 204],
				method: "POST",
			});
			await delay(1000);
			await expectMppx(
				"paid POST /sandboxes/:id/connect",
				`/sandboxes/${createdSandboxId}/connect`,
				{
					expected: [200, 201, 204],
					method: "POST",
				},
			);
		}
	}
} finally {
	if (createdSandboxId) {
		await expectMppx("cleanup DELETE /sandboxes/:id", `/sandboxes/${createdSandboxId}`, {
			expected: [200, 204, 404],
			method: "DELETE",
		});
	}
}

console.log("Smoke test passed.");

async function assertOpenApiPaths() {
	const response = await fetch(`${baseUrl}/openapi.json`);
	const spec = await response.json();
	const paths = Object.keys(spec.paths ?? {});
	assert(paths.includes("/sandboxes"), "OpenAPI should include /sandboxes");
	assert(!paths.some((path) => path.startsWith("/e2b")), "OpenAPI should not expose /e2b paths");
	console.log("ok OpenAPI exposes direct E2B paths only");
}

async function expectFetch(name, path, options = {}) {
	const headers = new Headers(options.headers);
	let body;
	if (options.body !== undefined) {
		body = JSON.stringify(options.body);
		headers.set("content-type", "application/json");
	}

	const response = await fetch(`${baseUrl}${path}`, {
		body,
		headers,
		method: options.method ?? "GET",
	});
	assertStatus(name, response.status, options.expected);
}

async function expectMppx(name, path, options = {}) {
	const commandArgs = [
		"exec",
		"mppx",
		`${baseUrl}${path}`,
		"--account",
		account,
		"--rpc-url",
		rpcUrl,
		"--insecure",
		"--include",
		"--verbose",
	];

	if (options.method && options.method !== "GET") {
		commandArgs.push("--method", options.method);
	}
	if (options.body !== undefined) {
		commandArgs.push("--json-body", JSON.stringify(options.body));
	}

	const { stdout, stderr } = await execFileAsync("pnpm", commandArgs, {
		maxBuffer: 10 * 1024 * 1024,
	});
	const status = finalHttpStatus(stdout);
	if (!status) {
		throw new Error(`${name}: could not parse HTTP status.\n${stdout}\n${stderr}`);
	}
	assertStatus(name, status, options.expected);
	return { stdout, stderr, status };
}

function assertStatus(name, actual, expected = [200]) {
	if (!expected.includes(actual)) {
		throw new Error(`${name}: expected ${expected.join("/")}, got ${actual}`);
	}
	console.log(`ok ${name} -> ${actual}`);
}

function finalHttpStatus(output) {
	const statuses = [...output.matchAll(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/gm)].map((match) =>
		Number(match[1]),
	);
	return statuses.at(-1);
}

function extractSandboxId(output) {
	const match = output.match(/\{[^\n]*"sandboxID"[^\n]*\}/);
	if (!match) return null;
	return JSON.parse(match[0]).sandboxID;
}

function parseArgs(rawArgs) {
	const parsed = {};
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = rawArgs[i + 1];
		if (!next || next.startsWith("--")) {
			parsed[key] = true;
		} else {
			parsed[key] = next;
			i++;
		}
	}
	return parsed;
}

function trimTrailingSlash(value) {
	return value.replace(/\/+$/, "");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}
