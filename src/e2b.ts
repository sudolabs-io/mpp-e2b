import { HTTPException } from "hono/http-exception";
import { custom, type Service } from "mppx/proxy";
import type { Env } from "./env.js";
import { jsonBody, type ServiceMppx } from "./mppx.js";
import { getPayer, payerTag } from "./payer.js";
import { PUBLIC_TEMPLATE_NAMES, PUBLIC_TEMPLATE_SPECS } from "./public-templates.js";

const E2B_API_BASE = "https://api.e2b.dev";

/**
 * E2B sandbox compute pricing.
 *
 * E2B charges per-second based on vCPU and RAM. We price per-request with
 * amounts that approximate the cost for the sandbox lifetime.
 *
 * Reference: https://e2b.dev/pricing
 *   - vCPU: $0.000104/s → ~$0.031/5min
 *   - GiB RAM: $0.0000208/s → ~$0.006/5min
 *   - Default: 2 vCPU + 512 MiB ≈ $0.065/5min
 *
 * We add a 30% margin.
 */

/** Per-second rate for 1 vCPU */
const VCPU_RATE = 0.000104;
/** Per-second rate for 1 GiB RAM */
const GIB_RAM_RATE = 0.0000208;

/** E2B limits */
const MAX_TIMEOUT_S = 86400;

export type SandboxSpec = { cpuCount: number; memoryMB: number };
type SandboxDetails = {
	cpuCount?: number;
	memoryMB?: number;
	metadata?: Record<string, string>;
};

function positiveNumber(value: unknown, fallback: number, max: number): number {
	// Omitted → default. Present but not a finite positive number (e.g. "abc", null,
	// 0, negative) → reject BEFORE charging, so a caller isn't billed for a request
	// E2B will reject anyway.
	const n = value === undefined ? fallback : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
		throw new HTTPException(400, { message: "Invalid numeric parameter" });
	}
	return Math.min(n, max);
}

/** Compute the USDC charge for running `spec` for `seconds`, with margin and a floor. */
function computeComputeCost(spec: SandboxSpec, seconds: number): string {
	const memGiB = spec.memoryMB / 1024;
	const cost = (spec.cpuCount * VCPU_RATE + memGiB * GIB_RAM_RATE) * seconds;
	return Math.max(cost * 1.3, 0.001).toFixed(6);
}

function resolveCreatePrice(
	timeout: number,
	spec: SandboxSpec,
): { amount: string; description: string } {
	return {
		amount: computeComputeCost(spec, timeout),
		description: `Create sandbox - ${spec.cpuCount} vCPU, ${spec.memoryMB} MiB, ${timeout}s`,
	};
}

/** Resolve pricing for extending a sandbox's TTL. */
function resolveExtendPrice(
	addedSeconds: number,
	spec: SandboxSpec,
): { amount: string; description: string } {
	return {
		amount: computeComputeCost(spec, addedSeconds),
		description: `Extend sandbox - ${addedSeconds}s`,
	};
}

async function getSandboxDetails(
	apiKey: string,
	sandboxId: string,
): Promise<SandboxDetails | null> {
	const res = await fetch(`${E2B_API_BASE}/sandboxes/${sandboxId}`, {
		headers: { "X-API-Key": apiKey },
	});
	if (!res.ok) return null;

	return (await res.json()) as SandboxDetails;
}

type TemplateListItem = {
	templateID?: string;
	aliases?: string[];
	cpuCount?: number;
	memoryMB?: number;
};

/**
 * Resolve a template's real CPU/RAM spec. E2B fixes resources at template build
 * time — they cannot be set per sandbox — so create pricing must come from here,
 * never from the request body.
 */
async function getTemplateSpec(apiKey: string, templateId: string): Promise<SandboxSpec | null> {
	const res = await fetch(`${E2B_API_BASE}/templates`, {
		headers: { "X-API-Key": apiKey },
	});
	if (!res.ok) return null;

	const templates = (await res.json()) as TemplateListItem[];
	if (!Array.isArray(templates)) return null;

	// Callers may pass either the raw templateID or a human-friendly alias.
	const match = templates.find(
		(t) => t.templateID === templateId || t.aliases?.includes(templateId),
	);
	if (!match) return null;

	if (typeof match.cpuCount !== "number" || typeof match.memoryMB !== "number") {
		throw new HTTPException(502, { message: "Template spec unavailable" });
	}

	return { cpuCount: match.cpuCount, memoryMB: match.memoryMB };
}

/** Spec to price a create request on — the chosen template's, or `base`. */
async function resolveCreateSpec(
	apiKey: string,
	templateId: string | undefined,
): Promise<SandboxSpec> {
	// E2B rejects a create with no templateID, so we reject here too — before
	// charging — rather than price a request that would fail upstream.
	if (!templateId) {
		throw new HTTPException(400, {
			message: `templateID is required. Use a public template (${PUBLIC_TEMPLATE_NAMES}).`,
		});
	}

	// Public templates aren't in the team-scoped /templates and have no spec
	// endpoint, so their specs are pinned in PUBLIC_TEMPLATE_SPECS. We check the
	// pinned table first; this assumes the operator has no team template whose alias
	// collides with a public name (e.g. "claude"). If that ever happens, a colliding
	// team template would be priced from the public table — resolve via /templates
	// first instead.
	const publicSpec = PUBLIC_TEMPLATE_SPECS.get(templateId);
	if (publicSpec) return publicSpec;

	const spec = await getTemplateSpec(apiKey, templateId);
	if (spec) return spec;
	throw new HTTPException(400, {
		message: `Unknown templateID "${templateId}". Use a public template (${PUBLIC_TEMPLATE_NAMES}).`,
	});
}

async function getPricingSpec(
	apiKey: string,
	sandboxId: string,
	payer: string | null,
): Promise<SandboxSpec> {
	const details = await getSandboxDetails(apiKey, sandboxId);
	if (!details) throw new HTTPException(404, { message: "Sandbox not found" });

	// Enforce ownership BEFORE the caller is charged, so a non-owner is rejected
	// rather than billed-then-denied. The payer is only known once a credential is
	// present (the paid request); on the unpaid 402 challenge it's null and there is
	// nothing to check yet. (The claimed payer is not cryptographically verified —
	// see payer.ts; binding to the verified payer needs the MPP identity extension.)
	if (payer && details.metadata?.["mpp-payer"] !== payerTag(payer)) {
		throw new HTTPException(404, { message: "Sandbox not found" });
	}

	// A running sandbox's SandboxDetail always carries its spec; if it somehow
	// doesn't, fail closed rather than invent a price.
	if (typeof details.cpuCount !== "number" || typeof details.memoryMB !== "number") {
		throw new HTTPException(502, { message: "Sandbox spec unavailable" });
	}
	return { cpuCount: details.cpuCount, memoryMB: details.memoryMB };
}

/** Fetch sandbox details and verify the payer owns it. */
async function assertSandboxOwned(apiKey: string, sandboxId: string, payer: string): Promise<void> {
	const data = await getSandboxDetails(apiKey, sandboxId);
	if (!data) throw new HTTPException(404, { message: "Sandbox not found" });

	if (data.metadata?.["mpp-payer"] !== payerTag(payer)) {
		throw new HTTPException(404, { message: "Sandbox not found" });
	}
}

export function createE2bService(env: Env, mppx: ServiceMppx): Service.Service {
	const apiKey = env.E2B_API_KEY;

	const createHandler: Service.IntentHandler = async (req: Request) => {
		const body = await jsonBody<{ timeout?: number; templateID?: string }>(req);
		const timeout = positiveNumber(body.timeout, 300, MAX_TIMEOUT_S);
		const spec = await resolveCreateSpec(apiKey, body.templateID);
		const { amount, description } = resolveCreatePrice(timeout, spec);
		return mppx.charge({ amount, description })(req);
	};

	/** Dynamic pricing for TTL refresh — charges based on sandbox spec × added time. */
	const refreshHandler: Service.IntentHandler = async (req: Request) => {
		const sandboxId = extractSandboxId(req.url);
		const spec = await getPricingSpec(apiKey, sandboxId, getPayer(req));
		const body = await jsonBody<{ duration?: number }>(req);
		const duration = positiveNumber(body.duration, 300, MAX_TIMEOUT_S);
		const { amount, description } = resolveExtendPrice(duration, spec);
		return mppx.charge({ amount, description })(req);
	};

	/** Dynamic pricing for timeout set — charges based on sandbox spec × timeout. */
	const timeoutHandler: Service.IntentHandler = async (req: Request) => {
		const sandboxId = extractSandboxId(req.url);
		const spec = await getPricingSpec(apiKey, sandboxId, getPayer(req));
		const body = await jsonBody<{ timeout?: number }>(req);
		const timeout = positiveNumber(body.timeout, 300, MAX_TIMEOUT_S);
		const { amount, description } = resolveExtendPrice(timeout, spec);
		return mppx.charge({ amount, description })(req);
	};

	const svc = custom("e2b", {
		baseUrl: E2B_API_BASE,
		title: "E2B",
		description:
			"Cloud sandboxes for AI agents — create, manage, and execute code in isolated environments. Pay per use with crypto.",
		docsLlmsUrl: () => "https://e2b.dev/docs/llms.txt",
		headers: {
			"X-API-Key": apiKey,
		},
		routes: {
			// --- Sandboxes ---
			"POST /sandboxes": createHandler,
			"GET /sandboxes": mppx.charge({ amount: "0.0001", description: "List sandboxes" }),
			"GET /sandboxes/:sandboxID": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox",
			}),
			"DELETE /sandboxes/:sandboxID": mppx.charge({
				amount: "0.001",
				description: "Kill sandbox",
			}),

			// --- Sandbox lifecycle ---
			"POST /sandboxes/:sandboxID/connect": mppx.charge({
				amount: "0.01",
				description: "Connect to sandbox (resume if paused)",
			}),
			"POST /sandboxes/:sandboxID/pause": mppx.charge({
				amount: "0.001",
				description: "Pause sandbox",
			}),
			"POST /sandboxes/:sandboxID/refreshes": refreshHandler,
			"POST /sandboxes/:sandboxID/timeout": timeoutHandler,

			// --- Snapshots ---
			"POST /sandboxes/:sandboxID/snapshots": mppx.charge({
				amount: "0.01",
				description: "Create snapshot from sandbox",
			}),

			// --- Observability (nominal charge for authenticated access) ---
			"GET /sandboxes/:sandboxID/logs": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox logs",
			}),
			"GET /v2/sandboxes/:sandboxID/logs": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox logs",
			}),
			"GET /sandboxes/:sandboxID/metrics": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox metrics",
			}),
		},
		rewriteRequest: async (req, ctx) => {
			const payer = getPayer(req);
			if (!payer) return req;

			const path = ctx.upstreamPath;

			// Tag created sandboxes with payer metadata for isolation
			if (req.method === "POST" && path === "/sandboxes") {
				const body = await jsonBody<{
					metadata?: Record<string, string>;
					[k: string]: unknown;
				}>(req);
				body.metadata = {
					...body.metadata,
					"mpp-payer": payerTag(payer),
				};
				return new Request(req.url, {
					method: req.method,
					headers: req.headers,
					body: JSON.stringify(body),
				});
			}

			// List: filter by payer metadata (overwrite, don't merge)
			if (req.method === "GET" && path === "/sandboxes") {
				const url = new URL(req.url);
				url.searchParams.set("metadata", `mpp-payer=${encodeURIComponent(payerTag(payer))}`);
				return new Request(url.toString(), {
					method: req.method,
					headers: req.headers,
				});
			}

			// Enforce ownership on all sandbox-scoped routes
			const sandboxId = sandboxIdFromPath(path);
			if (sandboxId) {
				await assertSandboxOwned(apiKey, sandboxId, payer);
			}

			return req;
		},
	});

	return svc;
}

/** Extract sandbox ID from the request URL path. */
function extractSandboxId(url: string): string {
	const path = new URL(url).pathname;
	const sandboxId = sandboxIdFromPath(path);
	if (!sandboxId) throw new HTTPException(400, { message: "Missing sandbox ID" });
	return sandboxId;
}

function sandboxIdFromPath(path: string): string | null {
	return path.match(/^\/(?:e2b\/)?(?:v2\/)?sandboxes\/([^/]+)/)?.[1] ?? null;
}
