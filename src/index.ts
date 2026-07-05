import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ShakeMode = "elide" | "images";

interface ShakeResult {
	mode: ShakeMode;
	toolResultsDropped: number;
	blocksDropped: number;
	imagesDropped?: number;
	tokensFreed: number;
	artifactId?: string;
}

type TextBlock = { type: "text"; text: string };
type ContentBlock = { type: string; text?: string; [key: string]: unknown };
type Message = { role?: string; content?: string | ContentBlock[]; [key: string]: unknown };
type SessionEntry = { type: string; id?: string; message?: Message; content?: string | ContentBlock[]; customType?: string; [key: string]: unknown };
type ToolCallBlock = { type: "toolCall"; id: string; name?: string; arguments?: Record<string, unknown> };
type ToolResultMessage = Message & {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ContentBlock[];
	prunedAt?: number;
	useless?: boolean;
	isError?: boolean;
	details?: { images?: unknown[] } | null;
};
type MutableSessionManager = {
	getBranch(): SessionEntry[];
	rewriteEntries?: () => Promise<void>;
	saveArtifact?: (content: string, toolType: string) => Promise<string | undefined>;
};

interface ShakeConfig {
	protectTokens: number;
	minSavings: number;
	fenceMinTokens: number;
	keepBoundaryId?: string;
}

interface ToolResultShakeRegion {
	kind: "toolResult";
	entry: SessionEntry;
	tokens: number;
	originalText: string;
	label: string;
}

interface BlockShakeRegion {
	kind: "block";
	entry: SessionEntry;
	blockIndex: number;
	start: number;
	end: number;
	tokens: number;
	originalText: string;
	label: string;
}

type ShakeRegion = ToolResultShakeRegion | BlockShakeRegion;

const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 0,
	minSavings: 0,
	fenceMinTokens: 400,
};

const PLACEHOLDER_TOKEN_ESTIMATE = 16;
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;
const SKILL_INTERNAL_URL_PREFIX = "skill://";

function estimateTokens(value: unknown): number {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	return Math.ceil(text.length / 4);
}

function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: `Unknown /shake mode "${verb}". Use elide or images.` };
}

function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const count = result.imagesDropped ?? 0;
		return count === 0 ? "No images found in this session." : `Dropped ${count} image${count === 1 ? "" : "s"} from this session.`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) parts.push(`${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`);
	if (result.blocksDropped > 0) parts.push(`${result.blocksDropped} block${result.blocksDropped === 1 ? "" : "s"}`);
	if (parts.length === 0) return "Nothing to shake.";
	return `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).`;
}

function textFromToolResult(message: ToolResultMessage): string {
	return message.content
		.filter((block): block is TextBlock => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message" || entry.message?.role !== "toolResult") return undefined;
	const message = entry.message;
	if (!Array.isArray(message.content) || typeof message.toolCallId !== "string" || typeof message.toolName !== "string") return undefined;
	return message as ToolResultMessage;
}

function entryTokens(entry: SessionEntry): number {
	if (entry.type === "message") return estimateTokens(entry.message);
	if (entry.type !== "custom_message") return 0;
	if (typeof entry.content === "string") return estimateTokens(entry.content);
	if (!Array.isArray(entry.content)) return 0;
	return estimateTokens(entry.content.filter((block): block is TextBlock => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n"));
}

function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, ToolCallBlock> {
	const toolCalls = new Map<string, ToolCallBlock>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && typeof block.id === "string") toolCalls.set(block.id, block as ToolCallBlock);
		}
	}
	return toolCalls;
}

function isProtectedToolResult(toolResult: ToolResultMessage, toolCall: ToolCallBlock | undefined): boolean {
	if (toolResult.toolName === "skill") return true;
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return false;
	return typeof toolCall.arguments?.path === "string" && toolCall.arguments.path.startsWith(SKILL_INTERNAL_URL_PREFIX);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	if (ranges.length <= 1) return ranges;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const kept: Array<{ start: number; end: number }> = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

function scanTextForBlockRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let inFence = false;
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;

	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		const trimmedStart = line.trimStart();
		const isFenceLine = trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~");

		if (isFenceLine) {
			if (!inFence) {
				inFence = true;
				fenceStart = lineStart;
			} else {
				inFence = false;
				ranges.push({ start: fenceStart, end: i });
				fenceStart = -1;
			}
			lineStart = i + 1;
			continue;
		}

		if (!inFence) {
			const openingMatch = line.length === trimmedStart.length ? OPENING_XML.exec(trimmedStart) : null;
			if (openingMatch) {
				if (tagStack.length === 0) xmlStart = lineStart;
				tagStack.push(openingMatch[1]);
			} else {
				const closingMatch = CLOSING_XML.exec(trimmedStart);
				if (closingMatch && tagStack.length > 0 && tagStack[tagStack.length - 1] === closingMatch[1]) {
					tagStack.pop();
					if (tagStack.length === 0 && xmlStart >= 0) {
						ranges.push({ start: xmlStart, end: i });
						xmlStart = -1;
					}
				}
			}
		}

		lineStart = i + 1;
	}
	return mergeRanges(ranges);
}

function pushBlockRegions(entry: SessionEntry, blockIndex: number, text: string, config: ShakeConfig, label: string, out: ShakeRegion[]): void {
	for (const range of scanTextForBlockRanges(text)) {
		const slice = text.slice(range.start, range.end);
		const tokens = estimateTokens(slice);
		if (tokens < config.fenceMinTokens) continue;
		out.push({ kind: "block", entry, blockIndex, start: range.start, end: range.end, tokens, originalText: slice, label });
	}
}

function scanContentBlocks(entry: SessionEntry, content: string | ContentBlock[] | undefined, config: ShakeConfig, label: string, out: ShakeRegion[]): void {
	if (typeof content === "string") {
		pushBlockRegions(entry, -1, content, config, label, out);
		return;
	}
	if (!Array.isArray(content)) return;
	for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
		const block = content[blockIndex];
		if (block.type === "text" && typeof block.text === "string") pushBlockRegions(entry, blockIndex, block.text, config, label, out);
	}
}

function collectBlockRegions(entry: SessionEntry, config: ShakeConfig, out: ShakeRegion[]): void {
	if (entry.type === "message") {
		const message = entry.message;
		if (!message) return;
		if (message.role === "assistant") scanContentBlocks(entry, message.content, config, "assistant", out);
		if (message.role === "user" || message.role === "developer") scanContentBlocks(entry, message.content, config, message.role, out);
		return;
	}
	if (entry.type === "custom_message") scanContentBlocks(entry, entry.content, config, entry.customType ?? "custom", out);
}

function collectShakeRegions(entries: SessionEntry[], config: ShakeConfig): ShakeRegion[] {
	const accumulatedAfter = new Array<number>(entries.length);
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		accumulatedAfter[i] = accumulated;
		accumulated += entryTokens(entries[i]);
	}

	const toolCallsById = collectToolCallsById(entries);
	const boundaryIndex = config.keepBoundaryId === undefined ? 0 : Math.max(0, entries.findIndex(entry => entry.id === config.keepBoundaryId));
	const regions: ShakeRegion[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (i < boundaryIndex) continue;
		const entry = entries[i];
		const toolResult = getToolResultMessage(entry);
		const uselessResult = toolResult !== undefined && toolResult.useless === true && toolResult.isError !== true;
		if (!uselessResult && accumulatedAfter[i] < config.protectTokens) continue;
		if (toolResult) {
			if (toolResult.prunedAt !== undefined) continue;
			if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId))) continue;
			const text = textFromToolResult(toolResult);
			if (text.length === 0) continue;
			regions.push({ kind: "toolResult", entry, tokens: estimateTokens(toolResult), originalText: text, label: toolResult.toolName });
			continue;
		}
		collectBlockRegions(entry, config, regions);
	}

	let savings = 0;
	for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE);
	return savings < config.minSavings ? [] : regions;
}

function applyShakeRegion(region: ShakeRegion, replacement: string): void {
	if (region.kind === "toolResult") {
		const message = region.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: replacement }];
		message.prunedAt = Date.now();
		return;
	}

	const target = region.entry.type === "message" ? region.entry.message : region.entry;
	if (!target) return;
	if (region.blockIndex === -1) {
		if (typeof target.content !== "string") return;
		target.content = target.content.slice(0, region.start) + replacement + target.content.slice(region.end);
		return;
	}
	if (!Array.isArray(target.content)) return;
	const block = target.content[region.blockIndex];
	if (block?.type !== "text" || typeof block.text !== "string") return;
	block.text = block.text.slice(0, region.start) + replacement + block.text.slice(region.end);
}

function applyShakeRegions(items: Array<{ region: ShakeRegion; replacement: string }>): void {
	const ordered = [...items].sort((a, b) => {
		const aStart = a.region.kind === "block" ? a.region.start : -1;
		const bStart = b.region.kind === "block" ? b.region.start : -1;
		return bStart - aStart;
	});
	for (const item of ordered) applyShakeRegion(item.region, item.replacement);
}

function stripImagesFromArrayContent(content: ContentBlock[]): { content: ContentBlock[]; removed: number } {
	const kept: ContentBlock[] = [];
	let removed = 0;
	for (const block of content) {
		if (block.type === "image") removed++;
		else kept.push(block);
	}
	if (removed > 0 && kept.length === 0) kept.push({ type: "text", text: "[image removed]" });
	return { content: removed === 0 ? content : kept, removed };
}

function stripImagesFromMessage(message: Message): number {
	if (Array.isArray(message.content)) {
		const result = stripImagesFromArrayContent(message.content);
		if (result.removed > 0) message.content = result.content;
		let removed = result.removed;
		if (message.role === "toolResult") {
			const details = (message as ToolResultMessage).details;
			if (details && Array.isArray(details.images)) {
				const original = details.images;
				details.images = original.filter(candidate => !(candidate && typeof candidate === "object" && (candidate as { type?: unknown }).type === "image"));
				removed += original.length - details.images.length;
			}
		}
		return removed;
	}
	if (message.role === "fileMention" && Array.isArray(message.files)) {
		let removed = 0;
		for (const file of message.files as Array<{ image?: unknown }>) {
			if (file.image) {
				file.image = undefined;
				removed++;
			}
		}
		return removed;
	}
	return 0;
}

function findLatestCompactionBoundary(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction" && typeof entry.firstKeptEntryId === "string") return entry.firstKeptEntryId;
	}
	return undefined;
}

async function saveShakeArtifact(sessionManager: MutableSessionManager, regions: ShakeRegion[]): Promise<string | undefined> {
	if (!sessionManager.saveArtifact) return undefined;
	const parts: string[] = [];
	for (let i = 0; i < regions.length; i++) {
		const region = regions[i];
		parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
	}
	try {
		return await sessionManager.saveArtifact(parts.join("\n"), "shake");
	} catch {
		return undefined;
	}
}

function shakePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
	if (artifactId) return `[shaken ~${region.tokens} tokens - recover: artifact://${artifactId} (region ${index + 1})]`;
	return `[shaken ~${region.tokens} tokens]`;
}

async function dropImages(sessionManager: MutableSessionManager): Promise<{ removed: number }> {
	const branchEntries = sessionManager.getBranch();
	let removed = 0;
	for (const entry of branchEntries) {
		if (entry.type === "message" && entry.message) {
			removed += stripImagesFromMessage(entry.message);
			continue;
		}
		if (entry.type === "custom_message" && Array.isArray(entry.content)) {
			const result = stripImagesFromArrayContent(entry.content);
			if (result.removed > 0) entry.content = result.content;
			removed += result.removed;
		}
	}
	if (removed > 0) await sessionManager.rewriteEntries?.();
	return { removed };
}

async function shake(sessionManager: MutableSessionManager, mode: ShakeMode): Promise<ShakeResult> {
	if (mode === "images") {
		const { removed } = await dropImages(sessionManager);
		return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
	}

	const branchEntries = sessionManager.getBranch();
	const regions = collectShakeRegions(branchEntries, { ...AGGRESSIVE_SHAKE_CONFIG, keepBoundaryId: findLatestCompactionBoundary(branchEntries) });
	if (regions.length === 0) return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };

	const artifactId = await saveShakeArtifact(sessionManager, regions);
	let toolResultsDropped = 0;
	let blocksDropped = 0;
	let originalTokens = 0;
	let replacementTokens = 0;
	const items = regions.map((region, index) => {
		if (region.kind === "toolResult") toolResultsDropped++;
		else blocksDropped++;
		originalTokens += region.tokens;
		const replacement = shakePlaceholder(region, index, artifactId);
		replacementTokens += estimateTokens(replacement);
		return { region, replacement };
	});

	applyShakeRegions(items);
	await sessionManager.rewriteEntries?.();
	return { mode, toolResultsDropped, blocksDropped, tokensFreed: Math.max(0, originalTokens - replacementTokens), artifactId };
}

export default function piShakeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("shake", {
		description: "Drop heavy content from context (tool results, large blocks, or images)",
		handler: async (args, ctx) => {
			const mode = parseShakeMode(args ?? "");
			if (typeof mode !== "string") {
				ctx.ui.notify(mode.error, "warning");
				return;
			}

			await ctx.waitForIdle();
			const sessionManager = ctx.sessionManager as unknown as MutableSessionManager;
			if (typeof sessionManager.rewriteEntries !== "function") {
				ctx.ui.notify("/shake is unavailable: this Pi version does not expose session rewriting to extensions.", "error");
				return;
			}

			const result = await shake(sessionManager, mode);
			ctx.ui.notify(formatShakeSummary(result), "info");
		},
	});
}
