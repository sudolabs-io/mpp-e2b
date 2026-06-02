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
