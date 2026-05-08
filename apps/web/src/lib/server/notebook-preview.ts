import { readFileSync } from 'node:fs';
import { getNotebookPath } from '@nbm/core';
import type { Notebook } from '@nbm/core';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';
import type { NotebookPreviewCell, NotebookPreviewResponse } from '$lib/api';

type PreviewLanguage = NotebookPreviewCell['language'];
type PreviewKind = NotebookPreviewCell['kind'];
type ParsedCell = Omit<NotebookPreviewCell, 'html'>;

let highlighterPromise: Promise<Highlighter> | null = null;

export async function buildNotebookPreview(nb: Notebook): Promise<NotebookPreviewResponse> {
  const path = getNotebookPath(nb.id, nb.name, nb.type, nb.workspace);
  const source = readFileSync(path, 'utf8');
  const { cells: parsed, warnings } = parseNotebookSource(nb, source);
  const cells = await highlightCells(
    shouldShowRawFallback(nb, parsed, warnings) ? fallbackCells(nb, source) : parsed,
  );

  return {
    notebook: { id: nb.id, name: nb.name, type: nb.type, path },
    cells,
    warnings,
  };
}

function shouldShowRawFallback(
  nb: Pick<Notebook, 'type'>,
  cells: ParsedCell[],
  warnings: string[],
): boolean {
  if (cells.length > 0) return false;
  if (nb.type === 'jupyter') return warnings.length > 0;
  return true;
}

export function parseNotebookSource(
  nb: Pick<Notebook, 'type'>,
  source: string,
): { cells: ParsedCell[]; warnings: string[] } {
  const warnings: string[] = [];
  const cells = parseNotebook(nb, source, warnings);
  return { cells, warnings };
}

function parseNotebook(
  nb: Pick<Notebook, 'type'>,
  source: string,
  warnings: string[],
): ParsedCell[] {
  switch (nb.type) {
    case 'jupyter':
      return parseJupyter(source, warnings);
    case 'marimo':
      return parseMarimo(source, warnings);
    case 'pluto':
      return parsePluto(source, warnings);
  }
}

async function highlightCells(cells: ParsedCell[]): Promise<NotebookPreviewCell[]> {
  const highlighter = await getHighlighter();
  return cells.map((cell) => ({
    ...cell,
    html: highlighter.codeToHtml(cell.source, {
      lang: cell.language,
      themes: { light: 'github-light', dark: 'github-dark' },
    }),
  }));
}

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    langs: ['python', 'julia', 'sql', 'json', 'markdown', 'text'],
    themes: ['github-light', 'github-dark'],
  });
  return highlighterPromise;
}

function parseJupyter(source: string, warnings: string[]): ParsedCell[] {
  try {
    const nb = JSON.parse(source) as {
      cells?: Array<{ cell_type?: string; source?: unknown; id?: string }>;
      metadata?: {
        language_info?: { name?: string };
        kernelspec?: { language?: string };
      };
    };
    if (!Array.isArray(nb.cells)) {
      warnings.push('Jupyter notebook has no cells array.');
      return [];
    }

    const notebookLanguage = normalizeLanguage(
      nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'python',
    );

    return nb.cells
      .map((cell, index): ParsedCell | null => {
        const kind = normalizeCellKind(cell.cell_type);
        if (!kind) return null;
        const cellSource = normalizeSource(cell.source).trimEnd();
        if (!cellSource.trim()) return null;
        return {
          id: cell.id || `cell-${index + 1}`,
          kind,
          language: kind === 'code' ? notebookLanguage : kind === 'markdown' ? 'markdown' : 'text',
          source: cellSource,
        };
      })
      .filter((cell): cell is ParsedCell => Boolean(cell));
  } catch {
    warnings.push('Could not parse Jupyter JSON; showing raw file.');
    return [];
  }
}

function parseMarimo(source: string, warnings: string[]): ParsedCell[] {
  const lines = source.split(/\r?\n/);
  const cells: ParsedCell[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarimoCellDecorator(lines[index])) continue;
    const defIndex = findNextFunction(lines, index + 1);
    if (defIndex < 0) continue;

    const body = extractIndentedBlock(lines, defIndex + 1);
    const cellSource = stripSyntheticReturn(dedent(body)).trim();
    if (!cellSource) continue;
    const sql = extractMarimoSql(cellSource);

    cells.push({
      id: `cell-${cells.length + 1}`,
      kind: 'code',
      language: sql === null ? 'python' : 'sql',
      source: sql ?? cellSource,
    });
    index = defIndex + body.length;
  }

  if (cells.length === 0) {
    warnings.push('Could not find marimo cell blocks; showing raw Python file.');
  }
  return cells;
}

function parsePluto(source: string, warnings: string[]): ParsedCell[] {
  const lines = source.split(/\r?\n/);
  const markers = lines
    .map((line, index) => {
      const match = line.match(/^# ╔═╡\s+(.+)$/);
      return match ? { id: match[1].trim(), index } : null;
    })
    .filter((marker): marker is { id: string; index: number } => Boolean(marker));

  if (markers.length === 0) {
    warnings.push('Could not find Pluto cell markers; showing raw Julia file.');
    return [];
  }

  const cells: ParsedCell[] = [];
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    const marker = markers[markerIndex];
    const next = markers[markerIndex + 1]?.index ?? lines.length;
    const cellSource = lines.slice(marker.index + 1, next).join('\n').trim();
    if (!cellSource || isPlutoMetadataCell(cellSource)) continue;

    const markdown = parsePlutoMarkdown(cellSource);
    cells.push({
      id: marker.id,
      kind: markdown ? 'markdown' : 'code',
      language: markdown ? 'markdown' : 'julia',
      source: markdown ?? cellSource,
    });
  }

  return cells;
}

function fallbackCells(nb: Notebook, source: string): ParsedCell[] {
  if (nb.type === 'jupyter') {
    return [{ id: 'raw', kind: 'raw', language: 'text', source }];
  }
  const language = nb.type === 'pluto' ? 'julia' : 'python';
  return [{ id: 'raw', kind: 'raw', language, source }];
}

function normalizeSource(source: unknown): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function normalizeCellKind(cellType: string | undefined): PreviewKind | null {
  if (cellType === 'code' || cellType === 'markdown' || cellType === 'raw') return cellType;
  return null;
}

function normalizeLanguage(language: string): PreviewLanguage {
  const normalized = language.toLowerCase();
  if (normalized.includes('python')) return 'python';
  if (normalized.includes('julia')) return 'julia';
  if (normalized.includes('sql')) return 'sql';
  if (normalized.includes('markdown')) return 'markdown';
  return 'text';
}

function extractMarimoSql(source: string): string | null {
  const match = source.match(/^\s*(?:[A-Za-z_]\w*\s*=\s*)?mo\.sql\(\s*/);
  if (!match) return null;
  const literalStart = match[0].length;
  const sql = readPythonStringLiteral(source, literalStart);
  if (sql === null) return null;

  const rest = source.slice(literalStart + sql.rawLength).trim();
  if (!rest.startsWith(')')) return null;
  if (rest.slice(1).trim()) return null;
  return sql.value.trim();
}

function readPythonStringLiteral(
  source: string,
  start: number,
): { value: string; rawLength: number } | null {
  let index = start;
  while (/[A-Za-z]/.test(source[index] ?? '')) index += 1;

  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  const triple = source.slice(index, index + 3) === quote.repeat(3);
  const contentStart = index + (triple ? 3 : 1);

  if (triple) {
    const end = source.indexOf(quote.repeat(3), contentStart);
    if (end < 0) return null;
    return {
      value: source.slice(contentStart, end),
      rawLength: end + 3 - start,
    };
  }

  for (let cursor = contentStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) {
      return {
        value: source.slice(contentStart, cursor),
        rawLength: cursor + 1 - start,
      };
    }
  }

  return null;
}

function isMarimoCellDecorator(line: string): boolean {
  return /^\s*@app\.cell(?:\(|\s*$)/.test(line);
}

function findNextFunction(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^def\s+\w+\(.*\):\s*$/.test(lines[index])) return index;
  }
  return -1;
}

function extractIndentedBlock(lines: string[], start: number): string[] {
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line);
  }
  return body;
}

function dedent(lines: string[]): string {
  const minIndent = lines
    .filter((line) => line.trim())
    .reduce((min, line) => Math.min(min, line.match(/^ */)?.[0].length ?? 0), Infinity);

  if (!Number.isFinite(minIndent) || minIndent === 0) return lines.join('\n');
  return lines.map((line) => line.slice(minIndent)).join('\n');
}

function stripSyntheticReturn(source: string): string {
  const lines = source.replace(/\s+$/g, '').split('\n');
  const last = lines[lines.length - 1];
  if (/^return(?:\s+.+)?$/.test(last.trim())) {
    lines.pop();
  }
  return lines.join('\n');
}

function isPlutoMetadataCell(source: string): boolean {
  return (
    source.startsWith('PLUTO_PROJECT_TOML_CONTENTS') ||
    source.startsWith('PLUTO_MANIFEST_TOML_CONTENTS') ||
    source.startsWith('# ╠═') ||
    source.includes('# ╔═╡ Cell order:')
  );
}

function parsePlutoMarkdown(source: string): string | null {
  const match = source.match(/^md"""([\s\S]*)"""$/);
  return match ? match[1].trim() : null;
}
