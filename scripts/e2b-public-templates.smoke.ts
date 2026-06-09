import { afterAll, describe, expect, test } from "vitest";
import { PUBLIC_TEMPLATES } from "../src/public-templates.js";

/**
 * Drift guard for PUBLIC_TEMPLATES.
 *
 * E2B's public templates have no programmatic spec source (see the PUBLIC_TEMPLATES
 * doc comment in src/public-templates.ts), so we pin their specs. This test hits the real E2B
 * API to confirm each freshly created public sandbox still matches its pinned spec.
 * If E2B ever changes a public template's resources, this fails loudly instead of
 * letting the proxy silently misprice it.
 *
 * Requires E2B_API_KEY; skipped otherwise.
 */
const E2B_API_BASE = "https://api.e2b.dev";
const apiKey = process.env.E2B_API_KEY;

describe.skipIf(!apiKey)("E2B public template specs", () => {
	const created: string[] = [];

	test.each(PUBLIC_TEMPLATES)("$aliases.0 matches its pinned spec", async (template) => {
		// Create by alias (not the raw templateID): the proxy keys pricing on the
		// alias, so this also catches E2B re-pointing an alias to a different build.
		const create = await fetch(`${E2B_API_BASE}/sandboxes`, {
			method: "POST",
			headers: { "X-API-Key": apiKey as string, "content-type": "application/json" },
			body: JSON.stringify({ templateID: template.aliases[0], timeout: 10 }),
		});
		expect(create.status, await create.clone().text()).toBe(201);
		const sandboxId = ((await create.json()) as { sandboxID?: string }).sandboxID;
		expect(sandboxId, "create response had no sandboxID").toBeTruthy();
		created.push(sandboxId as string);

		const detail = await fetch(`${E2B_API_BASE}/sandboxes/${sandboxId}`, {
			headers: { "X-API-Key": apiKey as string },
		});
		expect(detail.status).toBe(200);
		const spec = (await detail.json()) as { cpuCount?: number; memoryMB?: number };

		expect(
			{ cpuCount: spec.cpuCount, memoryMB: spec.memoryMB },
			`${template.aliases[0]} (${template.templateID}) drifted — update PUBLIC_TEMPLATES in src/public-templates.ts`,
		).toEqual(template.spec);
	});

	afterAll(async () => {
		await Promise.all(
			created.map((id) =>
				fetch(`${E2B_API_BASE}/sandboxes/${id}`, {
					method: "DELETE",
					headers: { "X-API-Key": apiKey as string },
				}),
			),
		);
	});
});
