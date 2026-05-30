import { Marked } from "marked";
import { configureSafeMarked } from "../../src/core/export-html/safe-marked.ts";

type MarkedLike = {
	use: (config: unknown) => void;
	parse: (text: string) => string;
};

/** Same marked major version as export-html/vendor/marked.min.js with export sanitizers applied. */
export function loadVendoredMarked(): MarkedLike {
	const marked = new Marked();
	configureSafeMarked(marked);
	return marked;
}
