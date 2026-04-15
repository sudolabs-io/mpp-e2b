import { describe, expect, it } from "vitest";
import { payerTag } from "../payer.js";

describe("payerTag", () => {
	it("uses the full address without 0x prefix", () => {
		const addr = "0xAbC123dEf456789000000000000000000000DEAD";
		const tag = payerTag(addr);
		expect(tag).toBe("mppx-abc123def456789000000000000000000000dead");
	});

	it("normalizes to lowercase", () => {
		expect(payerTag("0xAABBCC")).toBe(payerTag("0xaabbcc"));
	});

	it("handles address without 0x prefix", () => {
		const tag = payerTag("aabbcc");
		expect(tag).toBe("mppx-aabbcc");
	});

	it("produces different tags for different addresses", () => {
		const a = payerTag("0x1111111100000000000000000000000000000000");
		const b = payerTag("0x1111111200000000000000000000000000000000");
		expect(a).not.toBe(b);
	});
});
