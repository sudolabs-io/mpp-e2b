#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const env = { ...process.env };

setEnv("SMOKE_BASE_URL", args["base-url"]);
setEnv("MPPX_ACCOUNT", args.account);
setEnv("MPPX_RPC_URL", args["rpc-url"]);
setEnv("SMOKE_TIMEOUT", args.timeout);
if (args.create || args.full) env.SMOKE_CREATE = "1";
if (args.full) env.SMOKE_FULL = "1";

const child = spawn("pnpm", ["exec", "vitest", "run", "--config", "vitest.smoke.config.ts"], {
	env,
	stdio: "inherit",
});

child.on("exit", (code) => {
	process.exit(code ?? 1);
});

child.on("error", (error) => {
	console.error(error);
	process.exit(1);
});

function setEnv(name, value) {
	if (value !== undefined && value !== true) env[name] = value;
}

function parseArgs(rawArgs) {
	const parsed = {};
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--") continue;
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = rawArgs[i + 1];
		if (!next || next.startsWith("--")) {
			parsed[key] = true;
		} else {
			parsed[key] = next;
			i++;
		}
	}
	return parsed;
}
