import { describe, expect, test } from "vitest";
import piShakeExtension from "../src/index";

type CommandHandler = (args: string, ctx: any) => Promise<void>;
type EventHandler = (event: any, ctx: any) => Promise<any> | any;

function registerExtension() {
	let command: CommandHandler | undefined;
	const handlers = new Map<string, EventHandler[]>();
	const appended: Array<{ customType: string; data: any }> = [];

	piShakeExtension({
		registerCommand(name: string, definition: { handler: CommandHandler }) {
			expect(name).toBe("shake");
			command = definition.handler;
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: any) {
			appended.push({ customType, data });
		},
	} as any);

	expect(command).toBeDefined();
	return {
		command: command!,
		appended,
		async emit(event: string, payload: any, ctx: any = {}) {
			let result: any;
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(payload, ctx);
			}
			return result;
		},
	};
}

function makeNotifications() {
	const messages: string[] = [];
	return {
		messages,
		ui: { notify: (message: string) => messages.push(message) },
	};
}

describe("pi-shake extension", () => {
	test("/shake elide replaces selected tool results in future context", async () => {
		const extension = registerExtension();
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
					isError: false,
				},
			},
		];
		const notifications = makeNotifications();

		await extension.command("", {
			waitForIdle: async () => undefined,
			sessionManager: { getBranch: () => entries },
			ui: notifications.ui,
		});

		expect(extension.appended).toHaveLength(1);
		expect(extension.appended[0].customType).toBe("pi-shake-state");
		expect(notifications.messages[0]).toMatch(/^Shook 1 tool result \(~\d+ tokens freed\)\.$/);

		const messages = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "heavy output" }],
				isError: false,
			},
		];
		const result = await extension.emit("context", { messages });

		expect(result.messages[0].content[0]).toMatchObject({ type: "text" });
		expect(result.messages[0].content[0].text).toMatch(/^\[shaken ~\d+ tokens\]$/);
		// Saved session history is not destructively rewritten.
		expect((entries[1].message.content[0] as { text: string }).text).toBe("heavy output");
	});

	test("/shake images removes only images already present when the command ran", async () => {
		const extension = registerExtension();
		const oldImage = { type: "image", data: "old", mimeType: "image/png" };
		const newImage = { type: "image", data: "new", mimeType: "image/png" };
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "keep" }, oldImage],
				},
			},
		];
		const notifications = makeNotifications();

		await extension.command("images", {
			waitForIdle: async () => undefined,
			sessionManager: { getBranch: () => entries },
			ui: notifications.ui,
		});

		expect(notifications.messages).toEqual(["Dropped 1 image from this session."]);
		expect(extension.appended[0].data.imageSignatures).toHaveLength(1);

		const result = await extension.emit("context", {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "keep" }, oldImage, newImage],
				},
			],
		});

		expect(result.messages[0].content).toEqual([{ type: "text", text: "keep" }, newImage]);
		expect(entries[0].message.content).toEqual([{ type: "text", text: "keep" }, oldImage]);
	});

	test("session_start restores previously recorded shake state", async () => {
		const extension = registerExtension();

		await extension.emit("session_start", {}, {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pi-shake-state",
						data: {
							version: 1,
							rules: [
								{
									kind: "toolResult",
									toolCallId: "call-1",
									replacement: "[shaken ~3 tokens]",
									originalText: "heavy output",
									tokens: 3,
								},
							],
						},
					},
				],
			},
		});

		const result = await extension.emit("context", {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "heavy output" }],
					isError: false,
				},
			],
		});

		expect(result.messages[0].content).toEqual([{ type: "text", text: "[shaken ~3 tokens]" }]);
	});
});
