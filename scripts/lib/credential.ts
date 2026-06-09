import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Shared helpers for adversarial smoke tests that need fine-grained control over payment
 * credentials — minting a single reusable credential and re-sending it verbatim.
 *
 * The happy-path smoke suite shells out to the full `mppx <url>` command, which mints a
 * fresh payment per call and never exposes the credential. To test replay and
 * pay-before-check invariants we instead mint a credential explicitly (`mppx sign` over a
 * captured 402 challenge) and drive the raw HTTP ourselves.
 */

const execFileAsync = promisify(execFile);

export interface PayContext {
	/** Base URL of the running proxy, e.g. http://localhost:3001 (no trailing slash). */
	baseUrl: string;
	/** mppx account name to pay from. */
	account: string;
	/** Tempo RPC endpoint. */
	rpcUrl: string;
}

export interface RequestOptions {
	method?: string;
	body?: unknown;
}

export interface Response {
	status: number;
	body: string;
}

function buildInit(options: RequestOptions, auth?: string): RequestInit {
	const headers = new Headers();
	let payload: string | undefined;
	if (options.body !== undefined) {
		payload = JSON.stringify(options.body);
		headers.set("content-type", "application/json");
	}
	if (auth) headers.set("authorization", auth);
	return { method: options.method ?? "GET", headers, body: payload };
}

/**
 * Fetch a route unpaid and return its 402 `WWW-Authenticate` challenge value. Throws if
 * the route does not answer with a challenge (e.g. it was free, or errored).
 */
export async function fetchChallenge(
	ctx: PayContext,
	path: string,
	options: RequestOptions = {},
): Promise<string> {
	const response = await fetch(`${ctx.baseUrl}${path}`, buildInit(options));
	if (response.status !== 402) {
		throw new Error(
			`challenge ${options.method ?? "GET"} ${path}: expected 402, got ${response.status}`,
		);
	}
	const challenge = response.headers.get("www-authenticate");
	if (!challenge) {
		throw new Error(`challenge ${path}: response had no WWW-Authenticate header`);
	}
	return challenge;
}

/**
 * Mint one reusable payment credential for `path`: capture the 402 challenge, then sign it
 * once with the mppx CLI. The returned `Authorization` value can be re-sent to exercise
 * replay / ownership handling.
 */
export async function mintCredential(
	ctx: PayContext,
	path: string,
	options: RequestOptions = {},
): Promise<string> {
	const challenge = await fetchChallenge(ctx, path, options);
	const { stdout } = await execFileAsync(
		"pnpm",
		[
			"exec",
			"mppx",
			"sign",
			"--account",
			ctx.account,
			"--rpc-url",
			ctx.rpcUrl,
			"--challenge",
			challenge,
		],
		{ maxBuffer: 10 * 1024 * 1024 },
	);
	const auth = stdout
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.pop();
	if (!auth?.startsWith("Payment ")) {
		throw new Error(`mint ${path}: unexpected mppx sign output: ${auth?.slice(0, 120)}`);
	}
	return auth;
}

/** Send a request with a pre-minted credential and return its status + body text. */
export async function send(
	ctx: PayContext,
	path: string,
	auth: string,
	options: RequestOptions = {},
): Promise<Response> {
	const response = await fetch(`${ctx.baseUrl}${path}`, buildInit(options, auth));
	const body = await response.text();
	return { status: response.status, body };
}

/**
 * Run the full `mppx <url>` pay-and-retry flow as a child process (mints a fresh payment).
 * Use for legitimate setup actions (e.g. creating a sandbox) where replay control isn't
 * needed. Returns stdout/stderr and the final HTTP status parsed from `--include` output.
 */
export async function payRequest(
	ctx: PayContext,
	path: string,
	options: RequestOptions = {},
): Promise<{ stdout: string; stderr: string; status: number | undefined }> {
	const args = [
		"exec",
		"mppx",
		`${ctx.baseUrl}${path}`,
		"--account",
		ctx.account,
		"--rpc-url",
		ctx.rpcUrl,
		"--insecure",
		"--include",
	];
	if (options.method && options.method !== "GET") args.push("--method", options.method);
	if (options.body !== undefined) args.push("--json-body", JSON.stringify(options.body));

	const { stdout, stderr } = await execFileAsync("pnpm", args, { maxBuffer: 10 * 1024 * 1024 });
	const statuses = [...stdout.matchAll(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/gm)].map((m) => Number(m[1]));
	return { stdout, stderr, status: statuses.at(-1) };
}

export function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}
