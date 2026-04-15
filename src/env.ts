/**
 * Environment bindings for the E2B MPP proxy worker.
 */
export interface Env {
	// --- Core MPP ---
	TEMPO_ENV: "tempo" | "moderato";
	PAYEE_ADDRESS: string;
	MPPX_SECRET_KEY: string;
	FEE_PAYER_PRIVATE_KEY?: string;

	// --- E2B ---
	E2B_API_KEY: string;
}
