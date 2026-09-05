export interface DiffLine { before?: string; after?: string; oldLine?: number; newLine?: number; changed: boolean }

/** Bounded LCS alignment: large inputs remain exact, with a replacement block fallback. */
export function alignConfigurationDiff(before: string, after: string, startLine = 1): DiffLine[] {
  const lines = (text: string) => text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const left = lines(before), right = lines(after);
  const rows: DiffLine[] = [];
  const width = right.length + 1;
  const matrix = left.length * right.length <= 1_000_000 ? new Uint32Array((left.length + 1) * width) : null;
  if (matrix) for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i * width + j] = left[i] === right[j] ? 1 + matrix[(i + 1) * width + j + 1]! : Math.max(matrix[(i + 1) * width + j]!, matrix[i * width + j + 1]!);
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({ before: left[i], after: right[j], oldLine: startLine + i++, newLine: startLine + j++, changed: false });
    } else if (i < left.length && (j === right.length || !matrix || matrix[(i + 1) * width + j]! >= matrix[i * width + j + 1]!)) {
      rows.push({ before: left[i], oldLine: startLine + i++, changed: true });
    } else rows.push({ after: right[j], newLine: startLine + j++, changed: true });
  }
  // Pair adjacent removal/addition runs without inventing matching unchanged lines.
  const aligned: DiffLine[] = [];
  for (let index = 0; index < rows.length;) {
    if (!rows[index]!.changed) { aligned.push(rows[index++]!); continue; }
    const removed: DiffLine[] = [], added: DiffLine[] = [];
    while (index < rows.length && rows[index]!.changed) { const row = rows[index++]!; (row.before !== undefined ? removed : added).push(row); }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) aligned.push({ ...removed[k], ...added[k], changed: true });
  }
  return aligned;
}

export function diffSections(rows: DiffLine[], context = 3): { omitted: boolean; rows: DiffLine[] }[] {
  const visible = rows.map((_, i) => rows.slice(Math.max(0, i - context), i + context + 1).some(row => row.changed));
  const sections: { omitted: boolean; rows: DiffLine[] }[] = [];
  rows.forEach((row, i) => {
    const omitted = !visible[i];
    if (!sections.length || sections.at(-1)!.omitted !== omitted) sections.push({ omitted, rows: [] });
    sections.at(-1)!.rows.push(row);
  });
  return sections;
}
