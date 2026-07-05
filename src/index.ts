import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff, Theme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	applyEditToNormalizedContent,
	computeEditDiff,
	detectLineEnding,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const editSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute or relative path to the file to modify." }),
		old_string: Type.String({
			description: "The exact text to replace, including whitespace. Must be unique unless replace_all is true.",
		}),
		new_string: Type.String({ description: "The replacement text." }),
		replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence. Defaults to false." })),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;

type LegacyEditToolInput = Partial<EditToolInput> & {
	path?: unknown;
	oldText?: unknown;
	newText?: unknown;
	old_str?: unknown;
	new_str?: unknown;
	change_all?: unknown;
	edits?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as LegacyEditToolInput;
	const filePath =
		typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : undefined;
	let oldString =
		typeof args.old_string === "string"
			? args.old_string
			: typeof args.old_str === "string"
				? args.old_str
				: typeof args.oldText === "string"
					? args.oldText
					: undefined;
	let newString =
		typeof args.new_string === "string"
			? args.new_string
			: typeof args.new_str === "string"
				? args.new_str
				: typeof args.newText === "string"
					? args.newText
					: undefined;

	if (Array.isArray(args.edits) && args.edits.length === 1) {
		const [edit] = args.edits as Array<{ oldText?: unknown; newText?: unknown }>;
		oldString ??= typeof edit.oldText === "string" ? edit.oldText : undefined;
		newString ??= typeof edit.newText === "string" ? edit.newText : undefined;
	}

	const replaceAll =
		typeof args.replace_all === "boolean"
			? args.replace_all
			: typeof args.change_all === "boolean"
				? args.change_all
				: undefined;

	return {
		...args,
		...(filePath !== undefined ? { file_path: filePath } : {}),
		...(oldString !== undefined ? { old_string: oldString } : {}),
		...(newString !== undefined ? { new_string: newString } : {}),
		...(replaceAll !== undefined ? { replace_all: replaceAll } : {}),
	} as EditToolInput;
}

function validateEditInput(input: EditToolInput): Required<EditToolInput> {
	return {
		file_path: input.file_path,
		old_string: input.old_string,
		new_string: input.new_string,
		replace_all: input.replace_all ?? false,
	};
}

type RenderableEditArgs = {
	file_path?: string;
	path?: string;
	old_string?: string;
	new_string?: string;
	old_str?: string;
	new_str?: string;
	oldText?: string;
	newText?: string;
	replace_all?: boolean;
	change_all?: boolean;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(
	args: RenderableEditArgs | undefined,
): { path: string; oldString: string; newString: string; replaceAll: boolean } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : null;
	if (!path) {
		return null;
	}

	const oldString =
		typeof args.old_string === "string"
			? args.old_string
			: typeof args.old_str === "string"
				? args.old_str
				: typeof args.oldText === "string"
					? args.oldText
					: null;
	const newString =
		typeof args.new_string === "string"
			? args.new_string
			: typeof args.new_str === "string"
				? args.new_str
				: typeof args.newText === "string"
					? args.newText
					: null;
	if (oldString === null || newString === null) {
		return null;
	}

	return { path, oldString, newString, replaceAll: args.replace_all ?? args.change_all ?? false };
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Performs exact string replacement in a file. old_string must match exactly, including whitespace, and be unique unless replace_all is true.",
		promptSnippet: "Perform exact string replacement in a file",
		promptGuidelines: [
			"Use edit with file_path, old_string, and new_string for precise replacements.",
			"old_string must match exactly, including whitespace and newlines, and be unique unless replace_all is true.",
			"Use replace_all only when the user wants every occurrence replaced.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { file_path, old_string, new_string, replace_all } = validateEditInput(input);
			const absolutePath = resolveToCwd(file_path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${file_path}. ${errorMessage}.`);
				}
				throwIfAborted();

				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditToNormalizedContent(
					normalizedContent,
					{ oldText: old_string, newText: new_string },
					file_path,
					{ replaceAll: replace_all },
				);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(file_path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced text in ${file_path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({
						path: previewInput.path,
						oldString: previewInput.oldString,
						newString: previewInput.newString,
						replaceAll: previewInput.replaceAll,
					})
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditDiff(
					previewInput.path,
					previewInput.oldString,
					previewInput.newString,
					context.cwd,
					{ replaceAll: previewInput.replaceAll },
				).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({
						path: previewInput.path,
						oldString: previewInput.oldString,
						newString: previewInput.newString,
						replaceAll: previewInput.replaceAll,
					})
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

export default function editExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(createEditToolDefinition(ctx.cwd));
	});
}
