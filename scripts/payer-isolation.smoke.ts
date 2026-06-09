import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	mintCredential,
	type PayContext,
	payRequest,
	send,
	trimTrailingSlash,
} from "./lib/credential.js";

/**
 * Payer-isolation adversarial smoke tests.
 *
 * Sandboxes are tagged with their creator's payer (`metadata["mpp-payer"]`) and every
 * sandbox-scoped route checks ownership. A different payer must not be able to read,
 * extend, or kill someone else's sandbox. Crucially, the ownership check runs *before*
 * the charge (see `assertSandboxOwned` / `getPricingSpec` in `src/e2b.ts`), so a non-owner
 * is rejected without being billed.
 *
 * "Not charged" is asserted without touching the store: if the attacker had been
 * charged-then-denied, their payment would be consumed and a SECOND send of the same
 * credential would come back `402 "already been used"` (a replay). Because the check runs
 * first, the credential is never burned — so the re-send returns the same `404`. The
 * 404/404 vs 404/402 contrast is the whole test.
 *
 * Needs two funded mppx accounts: the owner (MPPX_ACCOUNT) and an attacker
 * (ATTACKER_ACCOUNT). Create + fund the attacker once with:
 *   pnpm exec mppx account create --account attacker --rpc-url <rpc>
 *   pnpm exec mppx account fund   --account attacker --rpc-url <rpc>
 */

const baseUrl = trimTrailingSlash(process.env.SMOKE_BASE_URL ?? "http://localhost:3000");
const rpcUrl = process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
const templateID = process.env.SMOKE_TEMPLATE_ID ?? "base";

// Opt-in: this suite needs a funded second account that does not exist in a fresh
// checkout. Gate the WHOLE suite (hooks included) on ATTACKER_ACCOUNT being set, so a
// default `pnpm smoke` skips it cleanly instead of failing in beforeAll.
const attackerAccount = process.env.ATTACKER_ACCOUNT;
const owner: PayContext = { baseUrl, rpcUrl, account: process.env.MPPX_ACCOUNT ?? "local-test" };
const attacker: PayContext = { baseUrl, rpcUrl, account: attackerAccount ?? "attacker" };

let sandboxId: string | undefined;

console.log(`Payer-isolation smoke testing ${baseUrl}`);
console.log(`owner: ${owner.account}   attacker: ${attacker.account}`);

const describeIsolation = attackerAccount ? describe : describe.skip;

describeIsolation("payer isolation", () => {
	beforeAll(async () => {
		// The owner creates a real sandbox; it gets tagged with the owner's payer.
		const create = await payRequest(owner, "/sandboxes", {
			method: "POST",
			body: { templateID, timeout: 60 },
		});
		expect(create.status, `create should 201, got ${create.status}\n${create.stdout}`).toBe(201);
		sandboxId = extractSandboxId(create.stdout);
		expect(
			sandboxId,
			`could not parse sandboxID from create response:\n${create.stdout}`,
		).toBeTruthy();
		console.log(`created sandbox ${sandboxId} owned by ${owner.account}`);
	}, 120_000);

	afterAll(async () => {
		if (!sandboxId) return;
		// Owner cleans up regardless of test outcome.
		await payRequest(owner, `/sandboxes/${sandboxId}`, { method: "DELETE" }).catch(() => {});
	}, 120_000);

	test("owner can read its own sandbox", async () => {
		const res = await payRequest(owner, `/sandboxes/${sandboxId}`);
		expect(res.status, `owner GET should 200, got ${res.status}\n${res.stdout}`).toBe(200);
	});

	test("attacker cannot GET another payer's sandbox, and is not charged", async () => {
		// chargeOwned path: ownership asserted before mppx.charge.
		const auth = await mintCredential(attacker, `/sandboxes/${sandboxId}`);

		const first = await send(attacker, `/sandboxes/${sandboxId}`, auth);
		expect(first.status, `attacker GET should be denied as 404, got ${first.status}`).toBe(404);
		expect(first.body).not.toContain("already been used");

		// Re-send the identical credential. If the attacker had been charged on the first
		// attempt, this would now be a replay (402). It must still be a clean 404.
		const second = await send(attacker, `/sandboxes/${sandboxId}`, auth);
		expect(second.status, `re-send should still be 404 (not charged), got ${second.status}`).toBe(
			404,
		);
		expect(second.body).not.toContain("already been used");
	});

	test("attacker cannot set timeout on another payer's sandbox, and is not charged", async () => {
		// Dynamic-pricing path: ownership asserted inside getPricingSpec, before the charge.
		const path = `/sandboxes/${sandboxId}/timeout`;
		const body = { timeout: 60 };
		const auth = await mintCredential(attacker, path, { method: "POST", body });

		const first = await send(attacker, path, auth, { method: "POST", body });
		expect(first.status, `attacker timeout should be denied as 404, got ${first.status}`).toBe(404);
		expect(first.body).not.toContain("already been used");

		const second = await send(attacker, path, auth, { method: "POST", body });
		expect(second.status, `re-send should still be 404 (not charged), got ${second.status}`).toBe(
			404,
		);
		expect(second.body).not.toContain("already been used");
	});
});

function extractSandboxId(output: string): string | undefined {
	const match = output.match(/\{[^\n]*"sandboxID"[^\n]*\}/);
	if (!match) return undefined;
	try {
		return JSON.parse(match[0]).sandboxID;
	} catch {
		return undefined;
	}
}
