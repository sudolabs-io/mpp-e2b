import { Credential } from "mppx";

/**
 * Extract the payer's wallet address from an Authorization: Payment credential.
 * Returns the lowercased address or null if not present.
 */
export function extractPayerAddress(request: Request): string | null {
	const auth = request.headers.get("authorization");
	if (!auth) return null;
	const payment = Credential.extractPaymentScheme(auth);
	if (!payment) return null;
	try {
		const cred = Credential.deserialize(payment);
		if (!cred.source) return null;
		const parts = cred.source.split(":");
		const address = parts[parts.length - 1];
		return address?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

/**
 * Get payer address from the x-payer-address header (set by proxy).
 */
export function getPayer(req: Request): string | null {
	const payer = req.headers.get("x-payer-address");
	if (!payer) return null;
	return payer.toLowerCase();
}

/**
 * Derive a full payer tag from a wallet address.
 * Uses the full address to avoid collisions.
 */
export function payerTag(payer: string): string {
	return `mppx-${payer.replace(/^0x/, "").toLowerCase()}`;
}
