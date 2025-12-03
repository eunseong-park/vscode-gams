export const declarationRegex = /^\s*(ACRONYM(S)?|ALIAS(ES)?|EQUATION(S)?|FILE(S)?|FUNCTION(S)?|MODEL(S)?|PARAMETER(S)?|SCALAR(S)?|(SINGLETON)?\s*SET(S)?|TABLE(S)?|(FREE|POSITIVE|NONNEGATIVE|NEGATIVE|BINARY|INTEGER|SOS1|SOS2|SEMICONT|SEMIINT)?\s*VARIABLE(S)?)\b/i;

export interface ParsedDeclaration {
	full: string; // full matched keyword text
	baseKeyword: string; // normalized base keyword for consumers (e.g., VARIABLE, SET, PARAMETER, ...)
}

export function parseDeclaration(line: string): ParsedDeclaration | null {
	if (!line) return null;
	const m = declarationRegex.exec(line);
	if (!m) return null;
	let baseKeyword = m[1].toUpperCase();
	if (baseKeyword.includes('VARIABLE')) {
		baseKeyword = 'VARIABLE';
	} else if (baseKeyword.includes('EQUATION')) {
		baseKeyword = 'EQUATION';
	} else if (baseKeyword.includes('MODEL')) {
		baseKeyword = 'MODEL';
	} else if (baseKeyword.includes('PARAMETER') || baseKeyword.includes('SCALAR') || baseKeyword.includes('TABLE')) {
		baseKeyword = 'PARAMETER';
	} else if (baseKeyword.includes('SET') || baseKeyword.includes('ALIAS')) {
		baseKeyword = 'SET';
	} else if (baseKeyword.includes('ACRONYM')) {
		baseKeyword = 'ACRONYM';
	} else if (baseKeyword.includes('FILE')) {
		baseKeyword = 'FILE';
	} else if (baseKeyword.includes('FUNCTION')) {
		baseKeyword = 'FUNCTION';
	}
	return { full: m[0].trim(), baseKeyword };
}
