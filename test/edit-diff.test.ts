import { describe, expect, it } from "vitest";
import { applyEditToNormalizedContent } from "../src/edit-diff.ts";

describe("applyEditToNormalizedContent", () => {
	it("replaces one unique occurrence by default", () => {
		const result = applyEditToNormalizedContent("one two three\n", { oldText: "two", newText: "2" }, "file.txt");

		expect(result.newContent).toBe("one 2 three\n");
	});

	it("rejects duplicate occurrences by default", () => {
		expect(() =>
			applyEditToNormalizedContent("one two two\n", { oldText: "two", newText: "2" }, "file.txt"),
		).toThrow("Found 2 occurrences");
	});

	it("replaces every occurrence when replaceAll is true", () => {
		const result = applyEditToNormalizedContent(
			"one two two\n",
			{ oldText: "two", newText: "2" },
			"file.txt",
			{ replaceAll: true },
		);

		expect(result.newContent).toBe("one 2 2\n");
	});

	it("rejects empty old text", () => {
		expect(() =>
			applyEditToNormalizedContent("one two\n", { oldText: "", newText: "2" }, "file.txt", {
				replaceAll: true,
			}),
		).toThrow("oldText must not be empty");
	});
});
