import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ShakeMode = "elide" | "images";

interface ShakeResult {
	mode: ShakeMode;
	toolResultsDropped: number;
	blocksDropped: number;
	imagesDropped?: number;
	tokensFreed: number;
}

type TextBlock = { type: "text"; text: string };
type ContentBlock = { type: string; text?: string; [key: string]: unknown };
type Message = { role?: string; content?: string | ContentBlock[]; toolCallId?: string; toolName?: string; prunedAt?: number; useless?: boolean; isError?: boolean; details?: { images?: unknown[] } | null };
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
type SessionReader = {
	getBranch(): SessionEntry[];
};
type ContextShakeRule =
	| { kind: "toolResult"; toolCallId: string; replacement: string; originalText: string; tokens: number }
	| { kind: "block"; replacement: string; originalText: string; tokens: number; label: string };
type PersistedShakeState = {
	version: 1;
	rules?: ContextShakeRule[];
	imageSignatures?: string[];
};
type ShakeState = {
	rules: ContextShakeRule[];
	imageSignatures: Set<string>;
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

function findLatestCompactionBoundary(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction" && typeof entry.firstKeptEntryId === "string") return entry.firstKeptEntryId;
	}
	return undefined;
}

const SHAKE_STATE_CUSTOM_TYPE = "pi-shake-state";

function createShakeState(): ShakeState {
	return { rules: [], imageSignatures: new Set() };
}

function isContextShakeRule(value: unknown): value is ContextShakeRule {
	if (!value || typeof value !== "object") return false;
	const rule = value as Partial<ContextShakeRule> & { kind?: unknown; replacement?: unknown; originalText?: unknown; tokens?: unknown };
	if (rule.kind !== "toolResult" && rule.kind !== "block") return false;
	if (typeof rule.replacement !== "string" || typeof rule.originalText !== "string" || typeof rule.tokens !== "number") return false;
	if (rule.kind === "toolResult") return typeof (rule as { toolCallId?: unknown }).toolCallId === "string";
	return typeof (rule as { label?: unknown }).label === "string";
}

function mergePersistedShakeState(state: ShakeState, data: unknown): void {
	if (!data || typeof data !== "object") return;
	const persisted = data as Partial<PersistedShakeState>;
	if (persisted.version !== 1) return;
	if (Array.isArray(persisted.rules)) {
		for (const rule of persisted.rules) {
			if (isContextShakeRule(rule) && !hasRule(state, rule)) state.rules.push(rule);
		}
	}
	if (Array.isArray(persisted.imageSignatures)) {
		for (const signature of persisted.imageSignatures) {
			if (typeof signature === "string") state.imageSignatures.add(signature);
		}
	}
}

function reconstructShakeState(sessionManager: SessionReader, state: ShakeState): void {
	state.rules = [];
	state.imageSignatures.clear();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === SHAKE_STATE_CUSTOM_TYPE) mergePersistedShakeState(state, entry.data);
	}
}

function replacementForRegion(region: ShakeRegion): string {
	return `[shaken ~${region.tokens} tokens]`;
}

function ruleFromRegion(region: ShakeRegion): ContextShakeRule | undefined {
	const replacement = replacementForRegion(region);
	if (region.kind === "toolResult") {
		const toolResult = getToolResultMessage(region.entry);
		if (!toolResult) return undefined;
		return { kind: "toolResult", toolCallId: toolResult.toolCallId, replacement, originalText: region.originalText, tokens: region.tokens };
	}
	return { kind: "block", replacement, originalText: region.originalText, tokens: region.tokens, label: region.label };
}

function hasRule(state: ShakeState, rule: ContextShakeRule): boolean {
	return state.rules.some(existing => {
		if (existing.kind !== rule.kind) return false;
		if (existing.kind === "toolResult" && rule.kind === "toolResult") return existing.toolCallId === rule.toolCallId;
		return existing.originalText === rule.originalText;
	});
}

function imageSignature(block: ContentBlock): string | undefined {
	if (block.type !== "image") return undefined;
	return JSON.stringify(block);
}

function collectImageSignaturesFromContent(content: string | ContentBlock[] | undefined, out: string[]): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const signature = imageSignature(block);
		if (signature) out.push(signature);
	}
}

function collectImageSignatures(entries: SessionEntry[]): string[] {
	const signatures: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message") collectImageSignaturesFromContent(entry.message?.content, signatures);
		else if (entry.type === "custom_message") collectImageSignaturesFromContent(entry.content, signatures);
	}
	return signatures;
}

function replaceAllText(value: string, oldText: string, newText: string): { value: string; changed: boolean } {
	if (!value.includes(oldText)) return { value, changed: false };
	return { value: value.split(oldText).join(newText), changed: true };
}

function applyBlockRulesToContent(content: string | ContentBlock[] | undefined, rules: ContextShakeRule[]): { content: string | ContentBlock[] | undefined; changed: boolean } {
	const blockRules = rules.filter((rule): rule is Extract<ContextShakeRule, { kind: "block" }> => rule.kind === "block");
	if (blockRules.length === 0) return { content, changed: false };
	let changed = false;
	if (typeof content === "string") {
		let next = content;
		for (const rule of blockRules) {
			const result = replaceAllText(next, rule.originalText, rule.replacement);
			next = result.value;
			changed = changed || result.changed;
		}
		return { content: next, changed };
	}
	if (!Array.isArray(content)) return { content, changed: false };
	const next = content.map(block => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		let text = block.text;
		let blockChanged = false;
		for (const rule of blockRules) {
			const result = replaceAllText(text, rule.originalText, rule.replacement);
			text = result.value;
			blockChanged = blockChanged || result.changed;
		}
		if (!blockChanged) return block;
		changed = true;
		return { ...block, text };
	});
	return { content: changed ? next : content, changed };
}

function stripRecordedImages(content: string | ContentBlock[] | undefined, imageSignatures: Set<string>): { content: string | ContentBlock[] | undefined; changed: boolean } {
	if (!Array.isArray(content) || imageSignatures.size === 0) return { content, changed: false };
	let removed = 0;
	const kept = content.filter(block => {
		const signature = imageSignature(block);
		if (!signature || !imageSignatures.has(signature)) return true;
		removed++;
		return false;
	});
	if (removed === 0) return { content, changed: false };
	return { content: kept.length === 0 ? [{ type: "text", text: "[image removed]" }] : kept, changed: true };
}

function applyContextShake(messages: Message[], state: ShakeState): { messages: Message[]; changed: boolean } {
	if (state.rules.length === 0 && state.imageSignatures.size === 0) return { messages, changed: false };
	let changed = false;
	const nextMessages = messages.map(message => {
		let next = message;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const rule = state.rules.find(candidate => candidate.kind === "toolResult" && candidate.toolCallId === message.toolCallId);
			if (rule && Array.isArray(message.content)) {
				const replacement = [{ type: "text", text: rule.replacement }];
				if (JSON.stringify(message.content) !== JSON.stringify(replacement)) {
					next = { ...next, content: replacement };
					changed = true;
				}
			}
		} else {
			const result = applyBlockRulesToContent(next.content, state.rules);
			if (result.changed) {
				next = { ...next, content: result.content };
				changed = true;
			}
		}

		const imageResult = stripRecordedImages(next.content, state.imageSignatures);
		if (imageResult.changed) {
			next = { ...next, content: imageResult.content };
			changed = true;
		}
		return next;
	});
	return { messages: changed ? nextMessages : messages, changed };
}

function shake(sessionManager: SessionReader, mode: ShakeMode, state: ShakeState, persist: (data: PersistedShakeState) => void): ShakeResult {
	const branchEntries = sessionManager.getBranch();
	if (mode === "images") {
		const imageSignatures = collectImageSignatures(branchEntries).filter(signature => !state.imageSignatures.has(signature));
		if (imageSignatures.length === 0) return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: 0, tokensFreed: 0 };
		for (const signature of imageSignatures) state.imageSignatures.add(signature);
		persist({ version: 1, imageSignatures });
		return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: imageSignatures.length, tokensFreed: 0 };
	}

	const regions = collectShakeRegions(branchEntries, { ...AGGRESSIVE_SHAKE_CONFIG, keepBoundaryId: findLatestCompactionBoundary(branchEntries) });
	const rules: ContextShakeRule[] = [];
	let toolResultsDropped = 0;
	let blocksDropped = 0;
	let originalTokens = 0;
	let replacementTokens = 0;
	for (const region of regions) {
		const rule = ruleFromRegion(region);
		if (!rule || hasRule(state, rule)) continue;
		rules.push(rule);
		if (rule.kind === "toolResult") toolResultsDropped++;
		else blocksDropped++;
		originalTokens += region.tokens;
		replacementTokens += estimateTokens(rule.replacement);
	}
	if (rules.length === 0) return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
	state.rules.push(...rules);
	persist({ version: 1, rules });
	return { mode, toolResultsDropped, blocksDropped, tokensFreed: Math.max(0, originalTokens - replacementTokens) };
}

export default function piShakeExtension(pi: ExtensionAPI): void {
	const state = createShakeState();

	pi.on("session_start", async (_event, ctx) => {
		reconstructShakeState(ctx.sessionManager as unknown as SessionReader, state);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructShakeState(ctx.sessionManager as unknown as SessionReader, state);
	});

	pi.on("context", async (event, _ctx) => {
		const result = applyContextShake(event.messages as unknown as Message[], state);
		if (!result.changed) return undefined;
		return { messages: result.messages as typeof event.messages };
	});

	pi.registerCommand("shake", {
		description: "Drop heavy content from future model context (tool results, large blocks, or images)",
		handler: async (args, ctx) => {
			const mode = parseShakeMode(args ?? "");
			if (typeof mode !== "string") {
				ctx.ui.notify(mode.error, "warning");
				return;
			}

			await ctx.waitForIdle();
			const result = shake(ctx.sessionManager as unknown as SessionReader, mode, state, data => pi.appendEntry(SHAKE_STATE_CUSTOM_TYPE, data));
			ctx.ui.notify(formatShakeSummary(result), "info");
		},
	});
}
