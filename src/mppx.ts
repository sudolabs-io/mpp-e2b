import { HTTPException } from "hono/http-exception";
import { Mppx, tempo } from "mppx/server";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Addresses } from "viem/tempo";
import type { Env } from "./env.js";
import { resolveStore } from "./store.js";

/** USDC.e token address on Tempo mainnet */
const USDCE_ADDRESS = "0x20c000000000000000000000b9537d11c60e8b50";

export type ServiceMppx = {
	charge: (params: {
		amount: string;
		description: string;
	}) => (req: Request) => Promise<import("mppx/proxy").Service.IntentResult>;
};

export function createMppx(env: Env) {
	const isTestnet = env.TEMPO_ENV !== "tempo";
	const currency = isTestnet ? Addresses.pathUsd : USDCE_ADDRESS;
	// Shared, persistent replay-protection store (Upstash) — falls back to in-memory
	// with a warning when unconfigured. See store.ts.
	const store = resolveStore(env);

	const feePayerAccount = env.FEE_PAYER_PRIVATE_KEY
		? privateKeyToAccount(env.FEE_PAYER_PRIVATE_KEY as Hex)
		: undefined;

	const chargeMethod = tempo.charge({
		currency,
		recipient: env.PAYEE_ADDRESS as Hex,
		decimals: 6,
		testnet: isTestnet,
		store,
		waitForConfirmation: false,
		...(feePayerAccount ? { feePayer: feePayerAccount } : {}),
	});

	const realm = env.TEMPO_ENV === "tempo" ? "e2b.mpp.tempo.xyz" : "e2b.mpp.moderato.tempo.xyz";

	return Mppx.create({ methods: [chargeMethod], secretKey: env.MPPX_SECRET_KEY, realm });
}

/** Safely parse JSON body from a request. Returns `{}` for empty bodies. */
export async function jsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
	const text = await req.clone().text();
	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new HTTPException(400, { message: "Request body must be valid JSON." });
		}
		throw error;
	}
}
