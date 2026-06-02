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

type RuntimeEnv = Partial<Env> | undefined;

type EnvSource = {
	TEMPO_ENV?: string;
	PAYEE_ADDRESS?: string;
	MPPX_SECRET_KEY?: string;
	FEE_PAYER_PRIVATE_KEY?: string;
	E2B_API_KEY?: string;
};

/** Build Env from Cloudflare bindings or Vercel/Node process.env. */
export function envFromRuntime(bindings: RuntimeEnv = undefined): Env {
	if (isCloudflareEnv(bindings)) {
		return envFromSource(bindings);
	}

	return envFromVercel();
}

function isCloudflareEnv(bindings: RuntimeEnv): bindings is Env {
	if (!bindings) return false;
	return Boolean(bindings.PAYEE_ADDRESS && bindings.MPPX_SECRET_KEY && bindings.E2B_API_KEY);
}

function envFromVercel(): Env {
	return envFromSource(getProcessEnv());
}

function envFromSource(source: EnvSource): Env {
	const tempoEnv = source.TEMPO_ENV ?? "moderato";
	if (tempoEnv !== "tempo" && tempoEnv !== "moderato") {
		throw new Error("TEMPO_ENV must be either 'tempo' or 'moderato'.");
	}

	const { PAYEE_ADDRESS, MPPX_SECRET_KEY, FEE_PAYER_PRIVATE_KEY, E2B_API_KEY } = source;
	if (!PAYEE_ADDRESS || !MPPX_SECRET_KEY || !E2B_API_KEY) {
		throw new Error("Missing PAYEE_ADDRESS, MPPX_SECRET_KEY, or E2B_API_KEY.");
	}

	return {
		TEMPO_ENV: tempoEnv,
		PAYEE_ADDRESS,
		MPPX_SECRET_KEY,
		FEE_PAYER_PRIVATE_KEY,
		E2B_API_KEY,
	};
}

function getProcessEnv(): NodeJS.ProcessEnv {
	return typeof process === "undefined" ? {} : process.env;
}
