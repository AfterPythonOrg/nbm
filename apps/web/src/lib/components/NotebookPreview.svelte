<script lang="ts">
  import type { NotebookPreviewResponse } from '$lib/api';
  import { previewStore } from '$lib/stores/preview.svelte';

  let preview = $state<NotebookPreviewResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let requestId = 0;
  const REFRESH_INTERVAL_MS = 2_000;

  $effect(() => {
    const notebookId = previewStore.selectedId;

    if (!notebookId) {
      preview = null;
      loading = false;
      error = null;
      return;
    }

    loadPreview(notebookId, true);
    const interval = window.setInterval(() => loadPreview(notebookId, false), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  });

  function loadPreview(notebookId: string, showLoading: boolean) {
    const currentRequest = ++requestId;
    if (showLoading) loading = true;

    fetch(`/api/notebooks/${notebookId}/preview`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as NotebookPreviewResponse;
      })
      .then((data) => {
        if (currentRequest !== requestId) return;
        preview = data;
      })
      .catch((e) => {
        if (currentRequest !== requestId) return;
        error = e instanceof Error ? e.message : String(e);
        preview = null;
      })
      .finally(() => {
        if (currentRequest === requestId && showLoading) loading = false;
      });
  }
</script>

<section class="h-full w-full overflow-auto bg-bg100 text-tx100">
  {#if !previewStore.selectedId}
    <div class="flex h-full items-center justify-center text-sm text-tx400">
      Select a notebook to preview.
    </div>
  {:else if loading}
    <div class="flex h-full items-center justify-center text-sm text-tx400">
      Loading preview...
    </div>
  {:else if error}
    <div class="flex h-full items-center justify-center px-6 text-sm text-pm500">
      Failed to load preview: {error}
    </div>
  {:else if preview}
    <div class="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-5">
      <header class="flex min-w-0 items-center gap-3 border-b border-bd300 pb-3">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold text-tx100">{preview.notebook.name}</h1>
          <p class="truncate text-xs text-tx400">{preview.notebook.path}</p>
        </div>
        <span class="shrink-0 rounded bg-bg300 px-2 py-1 text-xs uppercase text-tx300">
          {preview.notebook.type}
        </span>
      </header>

      {#if preview.warnings.length > 0}
        <div class="rounded bg-bg200 px-3 py-2 text-xs text-tx300">
          {preview.warnings.join(' ')}
        </div>
      {/if}

      {#if preview.cells.length === 0}
        <div class="py-10 text-center text-sm text-tx400">No previewable cells.</div>
      {:else}
        <ol class="flex flex-col gap-3">
          {#each preview.cells as cell, index (cell.id)}
            <li class="overflow-hidden rounded border border-bd300 bg-bg200">
              <div class="flex items-center justify-between border-b border-bd300 px-3 py-1.5 text-xs text-tx400">
                <span>Cell {index + 1}</span>
                <span>{cell.language}</span>
              </div>
              <div class="preview-code overflow-auto text-sm">
                {@html cell.html}
              </div>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}
</section>

<style>
  :global(.preview-code pre) {
    margin: 0;
    padding: 1rem;
    background: transparent !important;
    overflow: visible;
  }

  :global(.preview-code code) {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    font-size: 0.875rem;
    line-height: 1.6;
  }

  :global(.dark .preview-code .shiki),
  :global(.dark .preview-code .shiki span) {
    color: var(--shiki-dark) !important;
  }
</style>
