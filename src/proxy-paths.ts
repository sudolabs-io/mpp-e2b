/**
 * Public surface ↔ mppx internal routing.
 *
 * We run as a single-service proxy that serves E2B's API at the root, so callers use
 * clean, E2B-identical paths (`/sandboxes`, `/v2/sandboxes/:id/logs`, …) — a drop-in
 * replacement for `api.e2b.dev`.
 *
 * mppx, though, mounts every service under `/{serviceId}/`, and our service id is
 * "e2b" — so internally it only routes `/e2b/...`. The official `*.mpp.tempo.xyz`
 * services get this root → `/e2b/` mapping from Tempo's edge gateway; because we ship
 * to BOTH Vercel and Cloudflare and test with Vitest, we do it here instead — the one
 * layer common to all three targets (a platform rewrite would have to be duplicated
 * per platform and wouldn't run in tests).
 *
 * The rule: add the `/e2b` prefix to every incoming path before it reaches mppx,
 * except the few endpoints mppx serves at the root (its discovery docs) and paths
 * that already carry the prefix. Using this block-list — rather than an allow-list of
 * known E2B paths — means any current or future E2B route maps through automatically.
 */

export const E2B_SERVICE_PREFIX = "/e2b";

/** True for the internal, service-prefixed form (`/e2b`, `/e2b/...`). Used to hide it publicly. */
export function isServicePrefixedE2bPath(pathname: string): boolean {
	return pathname === E2B_SERVICE_PREFIX || pathname.startsWith(`${E2B_SERVICE_PREFIX}/`);
}

/** True for the OpenAPI document, which we generate ourselves instead of using mppx's auto one. */
export function isOpenApiPath(pathname: string): boolean {
	return pathname === "/openapi.json" || pathname === "/openapi.json/";
}

/**
 * Paths that must reach mppx unprefixed: the bare root and mppx's own root-level
 * discovery endpoints (`/openapi.json`, `/llms.txt`). Everything else belongs to the
 * E2B service and gets the prefix.
 */
function isRootEndpoint(pathname: string): boolean {
	return pathname === "/" || pathname === "/llms.txt" || isOpenApiPath(pathname);
}

/**
 * Translate a public request URL into the form mppx routes on by adding the `/e2b`
 * service prefix — unless the path is a root endpoint or is already prefixed.
 */
export function createProxyRequest(url: string, request: Request): Request {
	const proxyUrl = new URL(url);

	if (!isRootEndpoint(proxyUrl.pathname) && !isServicePrefixedE2bPath(proxyUrl.pathname)) {
		proxyUrl.pathname = `${E2B_SERVICE_PREFIX}${proxyUrl.pathname}`;
	}

	return new Request(proxyUrl.toString(), request);
}
