export const E2B_SERVICE_PREFIX = "/e2b";

export function isServicePrefixedE2bPath(pathname: string): boolean {
	return pathname === E2B_SERVICE_PREFIX || pathname.startsWith(`${E2B_SERVICE_PREFIX}/`);
}

export function isOpenApiPath(pathname: string): boolean {
	return pathname === "/openapi.json" || pathname === "/openapi.json/";
}

export function shouldUseUnprefixedE2bPath(pathname: string): boolean {
	return (
		pathname === "/sandboxes" ||
		pathname.startsWith("/sandboxes/") ||
		pathname.startsWith("/v2/sandboxes/")
	);
}

export function createProxyRequest(url: string, request: Request): Request {
	const proxyUrl = new URL(url);

	if (shouldUseUnprefixedE2bPath(proxyUrl.pathname)) {
		proxyUrl.pathname = `${E2B_SERVICE_PREFIX}${proxyUrl.pathname}`;
	}

	return new Request(proxyUrl.toString(), request);
}

export async function stripServicePrefixFromOpenApi(response: Response): Promise<Response> {
	const contentType = response.headers.get("content-type");
	if (!response.ok || !contentType?.includes("application/json")) return response;

	const spec = (await response.json()) as { paths?: Record<string, unknown> };
	if (spec.paths) {
		spec.paths = Object.fromEntries(
			Object.entries(spec.paths).map(([path, value]) => [
				path.startsWith(`${E2B_SERVICE_PREFIX}/`) ? path.slice(E2B_SERVICE_PREFIX.length) : path,
				value,
			]),
		);
	}

	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.set("content-type", "application/json");

	return new Response(JSON.stringify(spec), {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}
