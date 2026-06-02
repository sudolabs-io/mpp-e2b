import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const baseUrl = trimTrailingSlash(process.env.SMOKE_BASE_URL ?? "http://localhost:3000");
const account = process.env.MPPX_ACCOUNT ?? "local-test";
const rpcUrl = process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
const shouldCreate = envFlag("SMOKE_CREATE") || envFlag("SMOKE_FULL");
const shouldRunFullLifecycle = envFlag("SMOKE_FULL");
const timeout = Number(process.env.SMOKE_TIMEOUT ?? 60);

const fakeSandboxId = "smoke-test-sandbox-id";
const challengeRequests = [
	["GET /sandboxes challenge", "/sandboxes"],
	[
		"POST /sandboxes challenge",
		"/sandboxes",
		{ method: "POST", body: { templateID: "base", timeout } },
	],
	["GET /sandboxes/:id challenge", `/sandboxes/${fakeSandboxId}`],
	["DELETE /sandboxes/:id challenge", `/sandboxes/${fakeSandboxId}`, { method: "DELETE" }],
	[
		"POST /sandboxes/:id/connect challenge",
		`/sandboxes/${fakeSandboxId}/connect`,
		{ method: "POST" },
	],
	["POST /sandboxes/:id/pause challenge", `/sandboxes/${fakeSandboxId}/pause`, { method: "POST" }],
	[
		"POST /sandboxes/:id/refreshes challenge",
		`/sandboxes/${fakeSandboxId}/refreshes`,
		{ method: "POST", body: { duration: timeout } },
	],
	[
		"POST /sandboxes/:id/timeout challenge",
		`/sandboxes/${fakeSandboxId}/timeout`,
		{ method: "POST", body: { timeout } },
	],
	[
		"POST /sandboxes/:id/snapshots challenge",
		`/sandboxes/${fakeSandboxId}/snapshots`,
		{ method: "POST" },
	],
	["GET /sandboxes/:id/logs challenge", `/sandboxes/${fakeSandboxId}/logs`],
	["GET /v2/sandboxes/:id/logs challenge", `/v2/sandboxes/${fakeSandboxId}/logs`],
	["GET /sandboxes/:id/metrics challenge", `/sandboxes/${fakeSandboxId}/metrics`],
];

let createdSandboxId: string | undefined;

console.log(`Smoke testing ${baseUrl}`);
console.log(`mppx account: ${account}`);
console.log(`rpc url: ${rpcUrl}`);

describe.sequential("E2B proxy smoke", () => {
	test("OpenAPI exposes direct E2B paths only", async () => {
		const response = await fetch(`${baseUrl}/openapi.json`);
		expect(response.status).toBe(200);
		const spec = await response.json();
		const paths = Object.keys(spec.paths ?? {});
		expect(paths).toContain("/sandboxes");
		expect(paths.some((path) => path.startsWith("/e2b"))).toBe(false);
	});

	test("service-prefixed E2B routes are hidden", async () => {
		await expectFetch("GET /e2b/sandboxes is hidden", "/e2b/sandboxes", { expected: [404] });
	});

	test.each(challengeRequests)("%s", async (name, path, options = {}) => {
		await expectFetch(name, path, { expected: [402], ...options });
	});

	test("paid GET /sandboxes succeeds", async () => {
		await expectMppx("paid GET /sandboxes", "/sandboxes", { expected: [200] });
	});

	test.runIf(shouldCreate)("paid sandbox create/get/delete succeeds", async () => {
		const create = await expectMppx("paid POST /sandboxes", "/sandboxes", {
			expected: [201],
			method: "POST",
			body: { templateID: "base", timeout },
		});
		createdSandboxId = extractSandboxId(create.stdout);
		expect(createdSandboxId, "Could not find sandboxID in create response.").toBeTruthy();

		await expectMppx("paid GET /sandboxes/:id", `/sandboxes/${createdSandboxId}`, {
			expected: [200],
		});
	});

	test.runIf(shouldRunFullLifecycle)("paid sandbox lifecycle endpoints succeed", async () => {
		expect(createdSandboxId, "Full lifecycle requires a created sandbox.").toBeTruthy();

		await expectMppx("paid GET /sandboxes/:id/logs", `/sandboxes/${createdSandboxId}/logs`, {
			expected: [200],
		});
		await expectMppx("paid GET /v2/sandboxes/:id/logs", `/v2/sandboxes/${createdSandboxId}/logs`, {
			expected: [200],
		});
		await expectMppx("paid GET /sandboxes/:id/metrics", `/sandboxes/${createdSandboxId}/metrics`, {
			expected: [200],
		});
		await expectMppx("paid POST /sandboxes/:id/timeout", `/sandboxes/${createdSandboxId}/timeout`, {
			expected: [200, 204],
			method: "POST",
			body: { timeout },
		});
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
		await expectMppx("paid POST /sandboxes/:id/connect", `/sandboxes/${createdSandboxId}/connect`, {
			expected: [200, 201, 204],
			method: "POST",
			body: { timeout },
		});
	});
});

afterAll(async () => {
	if (!createdSandboxId) return;
	await expectMppx("cleanup DELETE /sandboxes/:id", `/sandboxes/${createdSandboxId}`, {
		expected: [200, 204, 404],
		method: "DELETE",
	});
});

async function expectFetch(name, path, options = {}) {
	const headers = new Headers(options.headers);
	let body: string | undefined;
	if (options.body !== undefined) {
		body = JSON.stringify(options.body);
		headers.set("content-type", "application/json");
	}

	const response = await fetch(`${baseUrl}${path}`, {
		body,
		headers,
		method: options.method ?? "GET",
	});
	expectStatus(name, response.status, options.expected);
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

	const { stdout, stderr } = await execMppx(commandArgs, name);
	const status = finalHttpStatus(stdout);
	if (!status) {
		throw new Error(`${name}: could not parse HTTP status.\n${stdout}\n${stderr}`);
	}
	expectStatus(name, status, options.expected);
	return { stdout, stderr, status };
}

async function execMppx(commandArgs, name) {
	try {
		return await execFileAsync("pnpm", commandArgs, {
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (error) {
		const stdout = typeof error?.stdout === "string" ? error.stdout : "";
		const stderr = typeof error?.stderr === "string" ? error.stderr : "";
		throw new Error(`${name}: mppx command failed.\n${stdout}\n${stderr}`);
	}
}

function expectStatus(name, actual, expected = [200]) {
	expect(expected, `${name}: expected ${expected.join("/")}, got ${actual}`).toContain(actual);
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

function trimTrailingSlash(value) {
	return value.replace(/\/+$/, "");
}

function envFlag(name) {
	return ["1", "true", "yes"].includes(String(process.env[name] ?? "").toLowerCase());
}
