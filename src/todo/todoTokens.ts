export const INSTRUCTION_PREFIX = "@instr";
export const PLAN_HEADER_PREFIX = "@plan";
export const PLAN_ITEM_PREFIX = "@plan:";

export type PlanHeaderParseResult = {
	slug: string;
	title: string;
};

export type PlanItemParseResult = {
	slug: string;
	text: string;
};

export function normalizePlanSlug(slug: string): string {
	return slug.trim().toLowerCase();
}

export function matchesInstructionPrefix(text: string): boolean {
	const trimmed = text.trimStart();
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith(INSTRUCTION_PREFIX)) {
		return false;
	}
	if (lower.length === INSTRUCTION_PREFIX.length) {
		return true;
	}
	const nextChar = lower.charAt(INSTRUCTION_PREFIX.length);
	return nextChar === ":" || /\s/.test(nextChar);
}

export function stripInstructionPrefix(text: string): string {
	const trimmed = text.trimStart();
	if (!matchesInstructionPrefix(trimmed)) {
		return text;
	}
	let remainder = trimmed.slice(INSTRUCTION_PREFIX.length);
	if (remainder.startsWith(":")) {
		remainder = remainder.slice(1);
	}
	return remainder.trimStart();
}

export function parsePlanHeader(text: string): PlanHeaderParseResult | null {
	const trimmed = text.trimStart();
	const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
	const match = firstLine.match(/^@plan\s+([^\s]+)(?:\s+(.*))?$/i);
	if (!match) {
		return null;
	}
	const slug = normalizePlanSlug(match[1] ?? "");
	if (!slug) {
		return null;
	}
	const title = (match[2] ?? "").trim();
	return { slug, title };
}

export function parsePlanItem(text: string): PlanItemParseResult | null {
	const trimmed = text.trimStart();
	const lines = trimmed.split(/\r?\n/);
	const firstLine = lines[0] ?? "";
	const lower = firstLine.toLowerCase();
	if (!lower.startsWith(PLAN_ITEM_PREFIX)) {
		return null;
	}
	const remainder = firstLine.slice(PLAN_ITEM_PREFIX.length);
	const match = remainder.match(/^([^\s]+)(?:\s+(.*))?$/);
	if (!match) {
		return null;
	}
	const slug = normalizePlanSlug(match[1] ?? "");
	if (!slug) {
		return null;
	}
	const restLine = (match[2] ?? "").trimStart();
	const restLines = lines.slice(1).join("\n");
	const combined = [restLine, restLines].filter(Boolean).join("\n");
	return { slug, text: combined };
}
