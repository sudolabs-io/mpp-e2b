import type { SandboxSpec } from "./e2b.js";

type PublicTemplate = { templateID: string; aliases: string[]; spec: SandboxSpec };

/**
 * E2B's public/default templates and their pinned specs.
 *
 * These are creatable by any team but have no API-key-reachable spec source. All
 * of these were checked (2026-06-02): the team-scoped `GET /templates` omits them
 * (even with `?public=true`); `GET /templates/<id>` is 404; `GET /templates/
 * aliases/<alias>` is 403 and carries no spec anyway; the create response omits
 * `cpuCount`/`memoryMB`; and the dashboard's tRPC default-templates endpoint is
 * browser-cookie-auth only. The only way to observe a public template's spec with
 * our API key is to create a sandbox and read its `SandboxDetail` — which we can't
 * do at pricing time, since the charge precedes the upstream call. So we pin them
 * here, keyed by every alias/name E2B exposes plus the raw templateID.
 *
 * Source: e2b.dev default-templates list, verified 2026-06-02.
 * `scripts/e2b-public-templates.smoke.ts` guards these against drift.
 */
export const PUBLIC_TEMPLATES: PublicTemplate[] = [
	{
		templateID: "rki5dems9wqfm4r03t7g",
		aliases: ["base", "e2b", "e2b/base", "e2b/e2b"],
		spec: { cpuCount: 2, memoryMB: 512 },
	},
	{
		templateID: "nlhz8vlwyupq845jsdg9",
		aliases: ["code-interpreter-v1", "e2b/code-interpreter-v1"],
		spec: { cpuCount: 2, memoryMB: 2048 },
	},
	{
		templateID: "k0wmnzir0zuzye6dndlw",
		aliases: ["desktop", "e2b/desktop"],
		spec: { cpuCount: 8, memoryMB: 8192 },
	},
	{
		templateID: "u2bzpic9lzyttv5jh36g",
		aliases: ["openclaw", "e2b/openclaw"],
		spec: { cpuCount: 4, memoryMB: 4096 },
	},
	{
		templateID: "rezjpxscgrqpw9oz0wfk",
		aliases: ["amp", "e2b/amp"],
		spec: { cpuCount: 2, memoryMB: 2048 },
	},
	{
		templateID: "77gbcsv20q8kxklidjhe",
		aliases: ["opencode", "e2b/opencode"],
		spec: { cpuCount: 2, memoryMB: 2048 },
	},
	{
		templateID: "u1yrkaokyjzef8qchho5",
		aliases: ["codex", "e2b/codex"],
		spec: { cpuCount: 2, memoryMB: 2048 },
	},
	{
		templateID: "wunszvjeuyrdgrt0z6o9",
		aliases: ["claude", "claude-code", "e2b/claude", "e2b/claude-code"],
		spec: { cpuCount: 4, memoryMB: 8192 },
	},
];

/** Lookup of every public templateID/alias/name → its pinned spec. */
export const PUBLIC_TEMPLATE_SPECS = new Map<string, SandboxSpec>(
	PUBLIC_TEMPLATES.flatMap((t) =>
		[t.templateID, ...t.aliases].map((key): [string, SandboxSpec] => [key, t.spec]),
	),
);

/** Primary alias of each public template, for error messages. */
export const PUBLIC_TEMPLATE_NAMES = PUBLIC_TEMPLATES.map((t) => t.aliases[0]).join(", ");
