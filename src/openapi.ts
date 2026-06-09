import { generateProxy } from "mppx/discovery";
import { Service } from "mppx/proxy";

/** Wrap a JSON schema as an OpenAPI `requestBody`. */
function jsonBody(schema: unknown) {
	return { required: true, content: { "application/json": { schema } } };
}

/** Request bodies for routes that take a JSON body, keyed by `"METHOD /path"`. */
const REQUEST_BODIES: Record<string, ReturnType<typeof jsonBody>> = {
	"POST /sandboxes": jsonBody({
		type: "object",
		required: ["templateID"],
		properties: {
			templateID: {
				type: "string",
				description:
					'Required. An E2B templateID or alias, or "base" for E2B\'s default image. CPU and RAM are fixed by the template and cannot be set per request.',
			},
			timeout: { type: "integer", default: 300, description: "Sandbox lifetime in seconds." },
			metadata: { type: "object", additionalProperties: { type: "string" } },
			envVars: { type: "object", additionalProperties: { type: "string" } },
		},
	}),
	"POST /sandboxes/:sandboxID/timeout": jsonBody({
		type: "object",
		required: ["timeout"],
		properties: {
			timeout: { type: "integer", description: "New timeout in seconds, measured from now." },
		},
	}),
	"POST /sandboxes/:sandboxID/refreshes": jsonBody({
		type: "object",
		required: ["duration"],
		properties: {
			duration: { type: "integer", description: "Seconds to extend the sandbox TTL by." },
		},
	}),
};

/**
 * Routes priced at request time (`amount` not statically known). mppx derives
 * `x-payment-info` only from `mppx.charge` routes, so these custom-handler routes
 * would otherwise look free in discovery. We advertise them as paid with a null
 * amount and a description of how the price is computed.
 */
const DYNAMIC_PAYMENT_DESCRIPTIONS: Record<string, string> = {
	"POST /sandboxes": "Create sandbox - priced by template vCPU/RAM x timeout",
	"POST /sandboxes/:sandboxID/timeout": "Set timeout - priced by the sandbox's vCPU/RAM x timeout",
	"POST /sandboxes/:sandboxID/refreshes":
		"Refresh TTL - priced by the sandbox's vCPU/RAM x duration",
};

function parsePattern(pattern: string): { method: string; path: string } {
	const tokens = pattern.trim().split(/\s+/);
	if (tokens.length >= 2) return { method: tokens[0], path: tokens.slice(1).join(" ") };
	return { method: "GET", path: tokens[0] };
}

/**
 * Build the OpenAPI discovery document from a service's own route map, so paths,
 * prices, and request bodies stay in sync with what the proxy actually charges.
 * Uses mppx's supported `generateProxy` generator (not post-hoc JSON edits).
 */
export function buildE2bOpenApi(
	service: Service.Service,
	opts: { title: string; version?: string },
): Record<string, unknown> {
	// Reference payment to clone for dynamically-priced routes — keeps currency,
	// recipient, and decimals correct for the active environment.
	let reference: Record<string, unknown> | null = null;
	for (const endpoint of Object.values(service.routes)) {
		const payment = endpoint ? Service.paymentOf(endpoint) : null;
		if (payment) {
			reference = payment;
			break;
		}
	}

	const routes = Object.entries(service.routes).map(([pattern, endpoint]) => {
		const { method, path } = parsePattern(pattern);
		let payment = endpoint ? Service.paymentOf(endpoint) : null;

		const dynamicDescription = DYNAMIC_PAYMENT_DESCRIPTIONS[pattern];
		if (!payment && dynamicDescription && reference) {
			payment = { ...reference, amount: null, description: dynamicDescription };
		}

		return {
			method,
			path,
			payment,
			...(REQUEST_BODIES[pattern] ? { requestBody: REQUEST_BODIES[pattern] } : {}),
		};
	});

	return generateProxy({
		info: { title: opts.title, version: opts.version ?? "1.0.0" },
		routes,
		serviceInfo: {
			...(service.categories?.length ? { categories: service.categories } : {}),
			docs: { llms: "/llms.txt" },
		},
	});
}
