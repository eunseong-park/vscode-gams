export interface SectionHeader {
    level: number;
    title: string;
}

// Canonical section regex: capture leading '*' sequence as level and the title.
// - allow hyphens inside the title
// - require at least one space before the trailing delimiter and three-or-more hyphens as delimiter
const sectionRegex = /^\s*(\*+)\s*(.*?)\s+[-]{3,}/;

export function parseSectionHeader(line: string): SectionHeader | null {
    if (!line) {return null;}
    const m = sectionRegex.exec(line);
    if (!m) {return null;}
    const level = m[1].length;
    const title = (m[2] || '').trim() || '(empty)';
    return { level, title };
}
