import { describe, expect, it } from 'vitest';
import { parseNotebookSource } from './notebook-preview';

describe('parseNotebookSource', () => {
  it('parses Jupyter source strings, source arrays, and markdown cells', () => {
    const { cells, warnings } = parseNotebookSource(
      { type: 'jupyter' },
      JSON.stringify({
        metadata: { language_info: { name: 'python' } },
        cells: [
          { id: 'a', cell_type: 'code', source: 'x = 1\nprint(x)' },
          { id: 'b', cell_type: 'code', source: ['y = 2\n', 'print(y)'] },
          { id: 'c', cell_type: 'markdown', source: ['# Title\n', 'Body'] },
        ],
      }),
    );

    expect(warnings).toEqual([]);
    expect(cells).toMatchObject([
      { id: 'a', kind: 'code', language: 'python', source: 'x = 1\nprint(x)' },
      { id: 'b', kind: 'code', language: 'python', source: 'y = 2\nprint(y)' },
      { id: 'c', kind: 'markdown', language: 'markdown', source: '# Title\nBody' },
    ]);
  });

  it('extracts marimo app cells and strips generated returns', () => {
    const { cells, warnings } = parseNotebookSource(
      { type: 'marimo' },
      [
        'import marimo as mo',
        'app = mo.App()',
        '',
        '@app.cell',
        'def __():',
        '    x = 1',
        '    y = x + 1',
        '    return y',
        '',
        '@app.cell(hide_code=True)',
        'def __():',
        '    print("hello")',
        '    return',
        '',
        'if __name__ == "__main__":',
        '    app.run()',
      ].join('\n'),
    );

    expect(warnings).toEqual([]);
    expect(cells).toMatchObject([
      { kind: 'code', language: 'python', source: 'x = 1\ny = x + 1' },
      { kind: 'code', language: 'python', source: 'print("hello")' },
    ]);
  });

  it('detects marimo SQL cells serialized as mo.sql calls', () => {
    const { cells, warnings } = parseNotebookSource(
      { type: 'marimo' },
      [
        'import marimo as mo',
        'app = mo.App()',
        '',
        '@app.cell',
        'def __():',
        '    result = mo.sql(f"""',
        '    SELECT *',
        '    FROM my_table',
        '    WHERE value > {threshold}',
        '    """)',
        '    return result',
        '',
        '@app.cell',
        'def __():',
        '    mo.sql("SELECT 1 AS one")',
        '    return',
      ].join('\n'),
    );

    expect(warnings).toEqual([]);
    expect(cells).toMatchObject([
      {
        kind: 'code',
        language: 'sql',
        source: 'SELECT *\nFROM my_table\nWHERE value > {threshold}',
      },
      { kind: 'code', language: 'sql', source: 'SELECT 1 AS one' },
    ]);
  });

  it('extracts Pluto cells and skips project metadata', () => {
    const { cells, warnings } = parseNotebookSource(
      { type: 'pluto' },
      [
        '### A Pluto.jl notebook ###',
        '# ╔═╡ code-cell',
        'x = 1',
        '# ╔═╡ markdown-cell',
        'md"""',
        '# Title',
        'Body',
        '"""',
        '# ╔═╡ project-cell',
        'PLUTO_PROJECT_TOML_CONTENTS = """',
        '[deps]',
        '"""',
        '# ╔═╡ Cell order:',
        '# ╠═code-cell',
        '# ╠═markdown-cell',
      ].join('\n'),
    );

    expect(warnings).toEqual([]);
    expect(cells).toMatchObject([
      { id: 'code-cell', kind: 'code', language: 'julia', source: 'x = 1' },
      { id: 'markdown-cell', kind: 'markdown', language: 'markdown', source: '# Title\nBody' },
    ]);
  });

  it('returns warnings and no cells for malformed Jupyter JSON', () => {
    const { cells, warnings } = parseNotebookSource({ type: 'jupyter' }, '{nope');

    expect(cells).toEqual([]);
    expect(warnings).toEqual(['Could not parse Jupyter JSON; showing raw file.']);
  });

  it('does not warn for an empty but valid Jupyter notebook', () => {
    const { cells, warnings } = parseNotebookSource(
      { type: 'jupyter' },
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    );

    expect(cells).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
