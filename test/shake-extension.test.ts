import { describe, expect, test } from "vitest";
import piShakeExtension from "../src/index";

function registerExtensionCommand() {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	piShakeExtension({
		registerCommand(name: string, definition: { handler: typeof handler }) {
			expect(name).toBe("shake");
			handler = definition.handler;
		},
	} as any);
	expect(handler).toBeDefined();
	return handler!;
}

describe("pi-shake extension", () => {
	test("/shake elide replaces tool results and stores original text in an artifact", async () => {
		const command = registerExtensionCommand();
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf hi" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "heavy output" }],
				},
			},
		];
		let rewritten = false;
		let artifactContent = "";
		const notifications: string[] = [];

		await command("", {
			waitForIdle: async () => undefined,
			sessionManager: {
				getBranch: () => entries,
				rewriteEntries: async () => {
					rewritten = true;
				},
				saveArtifact: async (content: string, toolType: string) => {
					expect(toolType).toBe("shake");
					artifactContent = content;
					return "abc123";
				},
			},
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(rewritten).toBe(true);
		expect(artifactContent).toContain("heavy output");
		expect(entries[1].message.content[0]).toMatchObject({ type: "text" });
		expect((entries[1].message.content[0] as { text: string }).text).toMatch(/^\[shaken ~\d+ tokens - recover: artifact:\/\/abc123 \(region 1\)\]$/);
		expect((entries[1].message as { prunedAt?: number }).prunedAt).toEqual(expect.any(Number));
		expect(notifications[0]).toMatch(/^Shook 1 tool result \(~\d+ tokens freed\)\.$/);
	});

	test("/shake images removes image content and keeps text", async () => {
		const command = registerExtensionCommand();
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "keep" },
						{ type: "image", data: "drop" },
					],
				},
			},
		];
		let rewritten = false;
		const notifications: string[] = [];

		await command("images", {
			waitForIdle: async () => undefined,
			sessionManager: {
				getBranch: () => entries,
				rewriteEntries: async () => {
					rewritten = true;
				},
			},
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(rewritten).toBe(true);
		expect(entries[0].message.content).toEqual([{ type: "text", text: "keep" }]);
		expect(notifications).toEqual(["Dropped 1 image from this session."]);
	});
});
