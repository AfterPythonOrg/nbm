<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  // Subpath import: `@nbm/core/const` is browser-safe (no node:path/fs).
  // Importing from `@nbm/core` directly would drag in paths.ts/registry.ts
  // and blow up at runtime with "Module 'node:path' has been externalized".
  import { DEFAULT_MODE } from '@nbm/core/const';
  import type { Mode } from '@nbm/core';
  import type {
    NotebookDetailResponse,
    NotebooksResponse,
    RunningItemDTO,
    WorkspaceGroupDTO,
  } from '$lib/api';
  import { tabStore } from '$lib/stores/tabs.svelte';
  import { previewStore } from '$lib/stores/preview.svelte';

  // Initial value before /api/notebooks resolves. Matches the system default
  // so we don't flash standalone-mode behavior at users who configured embedded.
  let mode = $state<Mode>(DEFAULT_MODE);
  let running = $state<RunningItemDTO[]>([]);
  let workspaces = $state<WorkspaceGroupDTO[]>([]);

  let runningExpanded = $state(true);
  let workspacesExpanded = $state(true);
  let collapsedWorkspaces = $state<Record<string, boolean>>({});
  let loadError = $state<string | null>(null);
  const stoppingIds = new SvelteSet<string>();
  const startingIds = new SvelteSet<string>();
  const removingIds = new SvelteSet<string>();
  const renamingIds = new SvelteSet<string>();
  const removingWorkspaceNames = new SvelteSet<string>();
  const renamingWorkspaceNames = new SvelteSet<string>();
  const updatingRuntimeIds = new SvelteSet<string>();
  let editingId = $state<string | null>(null);
  let editingName = $state('');
  let editingWorkspaceName = $state<string | null>(null);
  let editingWorkspaceValue = $state('');
  let runtimeEditingId = $state<string | null>(null);
  let runtimeBinary = $state('');
  let runtimeProject = $state('');
  type DetailEntry =
    | { status: 'loading' }
    | { status: 'ready'; data: NotebookDetailResponse }
    | { status: 'error' };
  type DetailPopover = { id: string; name: string; top: number; left: number };
  const detailCache = new SvelteMap<string, DetailEntry>();
  let detailPopover = $state<DetailPopover | null>(null);
  let detailHoverTimer: number | null = null;
  let detailHideTimer: number | null = null;
  let copiedDetailKey = $state<string | null>(null);
  let copiedDetailTimer: number | null = null;
  const DETAIL_HOVER_DELAY_MS = 250;
  const DETAIL_HIDE_DELAY_MS = 120;
  const DETAIL_POPOVER_WIDTH = 300;

  // Track known running IDs so we can detect newly appeared notebooks on each
  // poll and auto-open them in embedded mode. Seeded by the first poll so we
  // don't re-mount every running iframe on a page refresh — that would race
  // with +page.svelte's initial openTab and trigger marimo's "already
  // connected" guard for the older notebook.
  let knownRunningIds = new SvelteSet<string>();
  let knownRunningSeeded = false;

  // Poll so notebooks started/stopped from the terminal (or another browser
  // tab) show up here without a manual reload.
  const POLL_INTERVAL_MS = 3_000;

  onMount(() => {
    loadNotebooks();
    const interval = window.setInterval(loadNotebooks, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      clearDetailTimer();
      clearDetailHideTimer();
      clearCopiedDetailTimer();
    };
  });

  async function loadNotebooks() {
    try {
      const res = await fetch('/api/notebooks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as NotebooksResponse;
      mode = data.mode;
      running = data.running;
      workspaces = data.workspaces;
      selectInitialPreview(data);

      if (data.mode === 'embedded' && knownRunningSeeded) {
        // The API returns `running` sorted by startedAt desc, so running[0] is
        // the most recently started. Open all new notebooks as tabs (mounts
        // their iframes), then activate the newest one so it comes into view.
        const newIds = data.running
          .filter((nb) => !knownRunningIds.has(nb.id))
          .map((nb) => nb.id);
        for (const id of newIds) {
          await tabStore.openTab(id);
        }
        if (newIds.length > 0) {
          // newIds[0] is the newest (running is sorted desc by startedAt).
          tabStore.setActive(newIds[0]);
        }
      }
      knownRunningIds = new SvelteSet(data.running.map((nb) => nb.id));
      knownRunningSeeded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  function selectInitialPreview(data: NotebooksResponse) {
    // Standalone is the only mode that auto-fills the preview pane on load.
    // In embedded mode the preview is user-driven (set when a workspace row
    // is clicked, cleared when a running row is clicked), so we must not
    // clear it here on every 3s poll — that would yank the user out of the
    // preview they just opened.
    if (data.mode !== 'standalone') return;

    const notebookIds = new Set([
      ...data.running.map((nb) => nb.id),
      ...data.workspaces.flatMap((ws) => ws.notebooks.map((nb) => nb.id)),
    ]);
    if (previewStore.selectedId && notebookIds.has(previewStore.selectedId)) return;

    const firstNotebookId =
      data.running[0]?.id ?? data.workspaces.flatMap((ws) => ws.notebooks)[0]?.id ?? null;
    if (firstNotebookId) previewStore.select(firstNotebookId);
  }

  function toggleWorkspace(name: string) {
    collapsedWorkspaces[name] = !collapsedWorkspaces[name];
  }

  // Clicking a row under "Running" puts the notebook in view (iframe in
  // embedded, preview in standalone). In embedded we clear previewStore so
  // +page.svelte flips the right pane back from <NotebookPreview> to
  // <NotebookView>.
  function selectFromRunning(id: string) {
    if (mode === 'embedded') {
      previewStore.clear();
      tabStore.openTab(id);
      return;
    }
    previewStore.select(id);
  }

  // Clicking a row under "Workspaces" ALWAYS shows the preview, regardless
  // of mode or whether the notebook is currently running. To bring a running
  // notebook back into iframe view (embedded), the user clicks it again
  // under "Running".
  function selectFromWorkspace(id: string) {
    hideNotebookDetails();
    previewStore.select(id);
  }

  // The notebook the "Running" row should highlight: the active iframe tab
  // in embedded (independent of preview state — preview is a transient
  // detour), the previewed notebook in standalone (where there is no iframe
  // surface). Workspaces never highlight.
  function isViewed(id: string): boolean {
    if (mode === 'embedded') return tabStore.activeId === id;
    return previewStore.selectedId === id;
  }

  async function stopNotebook(id: string) {
    if (stoppingIds.has(id)) return;
    hideNotebookDetails();
    detailCache.delete(id);
    stoppingIds.add(id);
    try {
      const res = await fetch(`/api/notebooks/${id}/session`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Embedded mode: the iframe URL is now dead, drop the tab.
      if (mode === 'embedded') tabStore.closeTab(id);
      await loadNotebooks();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      stoppingIds.delete(id);
    }
  }

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function beginRename(id: string, name: string) {
    if (removingIds.has(id) || renamingIds.has(id)) return;
    hideNotebookDetails();
    cancelWorkspaceRename();
    editingId = id;
    editingName = name;
  }

  function cancelRename() {
    hideNotebookDetails();
    editingId = null;
    editingName = '';
  }

  function beginWorkspaceRename(name: string) {
    if (removingWorkspaceNames.has(name) || renamingWorkspaceNames.has(name)) return;
    hideNotebookDetails();
    cancelRename();
    editingWorkspaceName = name;
    editingWorkspaceValue = name;
  }

  function cancelWorkspaceRename() {
    editingWorkspaceName = null;
    editingWorkspaceValue = '';
  }

  async function startNotebook(id: string, isRunning: boolean) {
    if (
      isRunning ||
      startingIds.has(id) ||
      stoppingIds.has(id) ||
      removingIds.has(id) ||
      renamingIds.has(id)
    )
      return;
    hideNotebookDetails();
    detailCache.delete(id);
    startingIds.add(id);
    try {
      const res = await fetch(`/api/notebooks/${id}/session`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `HTTP ${res.status}`);
      }
      await loadNotebooks();
      // Embedded: auto-open the freshly started notebook in iframe view.
      // Clear the preview so we're not stuck in preview mode on the same
      // notebook the user just started (workspace-click sets preview).
      if (mode === 'embedded') {
        previewStore.clear();
        tabStore.openTab(id);
      } else {
        // Standalone has no iframe; show the new notebook in preview.
        previewStore.select(id);
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      startingIds.delete(id);
    }
  }

  async function removeNotebook(id: string) {
    if (removingIds.has(id)) return;
    hideNotebookDetails();
    removingIds.add(id);
    try {
      const res = await fetch(`/api/notebooks/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `HTTP ${res.status}`);
      }

      tabStore.closeTab(id);
      if (previewStore.selectedId === id) previewStore.clear();
      knownRunningIds.delete(id);
      detailCache.delete(id);
      await loadNotebooks();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      removingIds.delete(id);
    }
  }

  async function removeWorkspace(ws: WorkspaceGroupDTO) {
    if (removingWorkspaceNames.has(ws.name)) return;
    hideNotebookDetails();
    removingWorkspaceNames.add(ws.name);
    const ids = ws.notebooks.map((nb) => nb.id);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(ws.name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => null)) as { removedIds?: string[] } | null;
      const removedIds = data?.removedIds ?? ids;

      for (const id of removedIds) {
        tabStore.closeTab(id);
        knownRunningIds.delete(id);
        detailCache.delete(id);
      }
      if (previewStore.selectedId && removedIds.includes(previewStore.selectedId)) previewStore.clear();
      delete collapsedWorkspaces[ws.name];
      await loadNotebooks();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      removingWorkspaceNames.delete(ws.name);
    }
  }

  async function saveRename(id: string, currentName: string) {
    const name = editingName.trim();
    if (!name || name === currentName) {
      cancelRename();
      return;
    }
    if (renamingIds.has(id)) return;
    hideNotebookDetails();
    detailCache.delete(id);
    renamingIds.add(id);
    try {
      const res = await fetch(`/api/notebooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { notebook: { id: string } };

      tabStore.closeTab(id);
      knownRunningIds.delete(id);
      if (previewStore.selectedId === id) previewStore.select(data.notebook.id);
      cancelRename();
      await loadNotebooks();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      renamingIds.delete(id);
    }
  }

  async function saveWorkspaceRename(currentName: string) {
    const name = editingWorkspaceValue.trim();
    if (!name || name === currentName) {
      cancelWorkspaceRename();
      return;
    }
    if (renamingWorkspaceNames.has(currentName)) return;
    hideNotebookDetails();
    renamingWorkspaceNames.add(currentName);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(currentName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        workspace: { name: string };
        notebooks: Array<{ oldId: string; id: string; name: string }>;
      };

      const selectedId = previewStore.selectedId;
      const renamedSelected = data.notebooks.find((nb) => nb.oldId === selectedId);
      for (const nb of data.notebooks) {
        tabStore.closeTab(nb.oldId);
        knownRunningIds.delete(nb.oldId);
        detailCache.delete(nb.oldId);
      }
      if (renamedSelected) previewStore.select(renamedSelected.id);
      if (collapsedWorkspaces[currentName] !== undefined) {
        collapsedWorkspaces[data.workspace.name] = collapsedWorkspaces[currentName];
        delete collapsedWorkspaces[currentName];
      }
      cancelWorkspaceRename();
      await loadNotebooks();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      renamingWorkspaceNames.delete(currentName);
    }
  }

  function clearDetailTimer() {
    if (detailHoverTimer === null) return;
    window.clearTimeout(detailHoverTimer);
    detailHoverTimer = null;
  }

  function clearDetailHideTimer() {
    if (detailHideTimer === null) return;
    window.clearTimeout(detailHideTimer);
    detailHideTimer = null;
  }

  function clearCopiedDetailTimer() {
    if (copiedDetailTimer === null) return;
    window.clearTimeout(copiedDetailTimer);
    copiedDetailTimer = null;
  }

  function hideNotebookDetails() {
    clearDetailTimer();
    clearDetailHideTimer();
    clearCopiedDetailTimer();
    copiedDetailKey = null;
    runtimeEditingId = null;
    detailPopover = null;
  }

  function scheduleHideNotebookDetails() {
    clearDetailTimer();
    clearDetailHideTimer();
    detailHideTimer = window.setTimeout(() => {
      detailPopover = null;
      detailHideTimer = null;
    }, DETAIL_HIDE_DELAY_MS);
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') hideNotebookDetails();
  }

  function scheduleNotebookDetails(
    id: string,
    name: string,
    target: HTMLElement,
    disabled: boolean,
    isRunning: boolean,
  ) {
    if (disabled) return;
    clearDetailTimer();
    clearDetailHideTimer();
    detailHoverTimer = window.setTimeout(() => {
      detailPopover = { id, name, ...getDetailPopoverPosition(target) };
      void loadNotebookDetails(id, isRunning);
    }, DETAIL_HOVER_DELAY_MS);
  }

  function getDetailPopoverPosition(target: HTMLElement): { top: number; left: number } {
    const rect = target.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    const estimatedHeight = 220;
    const rightSideLeft = rect.right + gap;
    const left =
      rightSideLeft + DETAIL_POPOVER_WIDTH <= window.innerWidth - margin
        ? rightSideLeft
        : Math.max(margin, rect.left - DETAIL_POPOVER_WIDTH - gap);
    const top = Math.min(
      Math.max(margin, rect.top - 4),
      Math.max(margin, window.innerHeight - estimatedHeight - margin),
    );
    return { top, left };
  }

  async function loadNotebookDetails(id: string, isRunning: boolean) {
    const cached = detailCache.get(id);
    if (cached?.status === 'loading') return;
    if (cached?.status === 'ready' && Boolean(cached.data.session) === isRunning) return;
    if (cached?.status === 'error') return;

    detailCache.set(id, { status: 'loading' });
    try {
      const res = await fetch(`/api/notebooks/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as NotebookDetailResponse;
      detailCache.set(id, { status: 'ready', data });
    } catch {
      detailCache.set(id, { status: 'error' });
    }
  }

  async function copyDetailValue(e: MouseEvent, key: string, value: string) {
    e.stopPropagation();
    clearDetailHideTimer();
    try {
      await navigator.clipboard.writeText(value);
      copiedDetailKey = key;
      clearCopiedDetailTimer();
      copiedDetailTimer = window.setTimeout(() => {
        copiedDetailKey = null;
        copiedDetailTimer = null;
      }, 1_200);
    } catch {
      loadError = 'Failed to copy to clipboard';
    }
  }

  function beginRuntimeEdit(e: MouseEvent, detail: NotebookDetailResponse) {
    e.stopPropagation();
    clearDetailHideTimer();
    runtimeEditingId = detail.id;
    runtimeBinary = detail.runtime.binary;
    runtimeProject = detail.runtime.project ?? '';
  }

  function cancelRuntimeEdit(e?: MouseEvent) {
    e?.stopPropagation();
    runtimeEditingId = null;
    runtimeBinary = '';
    runtimeProject = '';
  }

  async function saveRuntime(e: MouseEvent, detail: NotebookDetailResponse) {
    e.stopPropagation();
    if (detail.session || updatingRuntimeIds.has(detail.id)) return;
    updatingRuntimeIds.add(detail.id);
    try {
      const body = {
        runtime: {
          binary: runtimeBinary,
          project: detail.type === 'pluto' ? runtimeProject : undefined,
        },
      };
      const res = await fetch(`/api/notebooks/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(bodyText || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { notebook: { runtime: NotebookDetailResponse['runtime'] } };
      detailCache.set(detail.id, { status: 'ready', data: { ...detail, runtime: data.notebook.runtime } });
      cancelRuntimeEdit();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      updatingRuntimeIds.delete(detail.id);
    }
  }
</script>

{#snippet caret(open: boolean)}
  <svg
    class="size-3 shrink-0 text-tx400 transition-transform"
    style:transform={open ? 'rotate(90deg)' : 'rotate(0deg)'}
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
  >
    <path d="M4.5 3 L8 6 L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet dotActive()}
  <span class="inline-block size-2 shrink-0 rounded-full bg-pm500"></span>
{/snippet}

{#snippet dotInactive()}
  <span class="inline-block size-2 shrink-0 rounded-full border border-bd700"></span>
{/snippet}

{#snippet spinner()}
  <span
    class="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-bg600 border-t-pm500"
    aria-hidden="true"
  ></span>
{/snippet}

{#snippet stopIcon()}
  <svg
    class="size-3"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M3 3h6v6H3z" />
  </svg>
{/snippet}

{#snippet trashIcon()}
  <svg
    class="size-3.5"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3 3.5h6" />
    <path d="M5 3.5V2.25h2V3.5" />
    <path d="M4 5l.35 4h3.3L8 5" />
  </svg>
{/snippet}

{#snippet editIcon()}
  <svg
    class="size-3.5"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M7.5 2.5 9.5 4.5" />
    <path d="M8.75 1.75a.7.7 0 0 1 1 1L4.5 8 2 8.75 2.75 6.25z" />
  </svg>
{/snippet}

{#snippet checkIcon()}
  <svg
    class="size-3.5"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 6.25 5 8.5 9.5 3.5" />
  </svg>
{/snippet}

{#snippet cancelIcon()}
  <svg
    class="size-3.5"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3.5 3.5 8.5 8.5" />
    <path d="M8.5 3.5 3.5 8.5" />
  </svg>
{/snippet}

{#snippet copyIcon()}
  <svg
    class="size-3.5"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 4h4v4H4z" />
    <path d="M2.5 6.5V2.5h4" />
  </svg>
{/snippet}

{#snippet detailLine(label: string, value: string, copyKey: string | null)}
  <div class="flex min-w-0 items-center gap-2">
    <span class="shrink-0 text-tx400">{label}</span>
    <span class="min-w-0 flex-1 truncate text-right text-tx200" title={value}>{value}</span>
    {#if copyKey}
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center rounded text-tx400 hover:bg-bg300 hover:text-tx100"
        aria-label={`Copy ${label.toLowerCase()}`}
        title={`Copy ${label.toLowerCase()}`}
        onclick={(e) => copyDetailValue(e, copyKey, value)}
      >
        {#if copiedDetailKey === copyKey}
          {@render checkIcon()}
        {:else}
          {@render copyIcon()}
        {/if}
      </button>
    {/if}
  </div>
{/snippet}

<svelte:window onkeydown={handleGlobalKeydown} />

<aside class="flex h-full w-full flex-col overflow-hidden border-r border-bd300 bg-bg200 text-tx200">
  {#if loadError}
    <div class="px-3 py-2 text-xs text-pm500">Failed to load: {loadError}</div>
  {/if}

  <!-- RUNNING -->
  <section class="flex flex-col border-b border-bd300 pb-1">
    <button
      type="button"
      class="flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-tx300 hover:bg-bg300"
      onclick={() => (runningExpanded = !runningExpanded)}
    >
      {@render caret(runningExpanded)}
      <span>Running</span>
      <span class="text-tx400">({running.length})</span>
    </button>
    {#if runningExpanded}
      <ul>
        {#each running as nb (nb.id)}
          {@const viewed = isViewed(nb.id)}
          <li>
            <div class="flex items-center gap-1 px-3 py-1 pl-7 text-sm hover:bg-bg300" class:bg-bg400={viewed}>
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                class:font-bold={viewed}
                onclick={() => selectFromRunning(nb.id)}
              >
                {@render dotActive()}
                <span class="truncate font-mono">{nb.name}</span>
              </button>
              <button
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded text-tx300 hover:bg-bg400 disabled:opacity-50"
                aria-label={`Stop ${nb.name}`}
                title="Stop"
                disabled={stoppingIds.has(nb.id)}
                onclick={(e) => {
                  e.stopPropagation();
                  stopNotebook(nb.id);
                }}
              >
                {@render stopIcon()}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- WORKSPACES -->
  <section class="flex min-h-0 flex-1 flex-col">
    <button
      type="button"
      class="flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-tx300 hover:bg-bg300"
      onclick={() => (workspacesExpanded = !workspacesExpanded)}
    >
      {@render caret(workspacesExpanded)}
      <span>Workspaces</span>
    </button>
    {#if workspacesExpanded}
      <div class="min-h-0 flex-1 overflow-y-auto pb-2">
        {#each workspaces as ws (ws.name)}
          {@const collapsed = collapsedWorkspaces[ws.name] === true}
          {@const workspaceRemoving = removingWorkspaceNames.has(ws.name)}
          {@const workspaceRenaming = renamingWorkspaceNames.has(ws.name)}
          <div
            class="group flex items-center gap-1 px-3 py-1 pl-5 text-sm text-tx300 transition-colors hover:bg-bg300"
            class:opacity-60={workspaceRemoving || workspaceRenaming}
          >
            {#if editingWorkspaceName === ws.name}
              {@render caret(!collapsed)}
              <input
                use:focusOnMount
                class="min-w-0 flex-1 rounded border border-bd500 bg-bg100 px-1.5 py-0.5 text-sm text-tx100 outline-none ring-0 focus:border-pm500 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
                aria-label={`Rename workspace ${ws.name}`}
                disabled={workspaceRenaming}
                bind:value={editingWorkspaceValue}
                onkeydown={(e) => {
                  if (e.key === 'Enter') saveWorkspaceRename(ws.name);
                  if (e.key === 'Escape') cancelWorkspaceRename();
                }}
              />
              <button
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded text-tx300 hover:bg-bg400 hover:text-pm500 disabled:opacity-50"
                aria-label={`Save workspace ${ws.name} name`}
                title="Save"
                disabled={workspaceRenaming}
                onclick={(e) => {
                  e.stopPropagation();
                  saveWorkspaceRename(ws.name);
                }}
              >
                {@render checkIcon()}
              </button>
              <button
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded text-tx400 hover:bg-bg400 disabled:opacity-50"
                aria-label={`Cancel renaming workspace ${ws.name}`}
                title="Cancel"
                disabled={workspaceRenaming}
                onclick={(e) => {
                  e.stopPropagation();
                  cancelWorkspaceRename();
                }}
              >
                {@render cancelIcon()}
              </button>
            {:else}
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                disabled={workspaceRemoving || workspaceRenaming}
                onclick={() => toggleWorkspace(ws.name)}
              >
                {@render caret(!collapsed)}
                <span class="truncate">{ws.name}</span>
              </button>
              <button
                type="button"
                class="pointer-events-none flex size-6 shrink-0 items-center justify-center rounded text-tx400 opacity-0 transition-opacity hover:bg-bg400 hover:text-tx200 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:opacity-50"
                aria-label={`Edit workspace ${ws.name} name`}
                title="Edit workspace name"
                disabled={workspaceRemoving || workspaceRenaming}
                onclick={(e) => {
                  e.stopPropagation();
                  beginWorkspaceRename(ws.name);
                }}
              >
                {@render editIcon()}
              </button>
              <button
                type="button"
                class="pointer-events-none flex size-6 shrink-0 items-center justify-center rounded text-tx400 opacity-0 transition-opacity hover:bg-bg400 hover:text-pm500 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:opacity-50"
                aria-label={`Remove workspace ${ws.name} and all notebooks`}
                title="Remove workspace"
                disabled={workspaceRemoving || workspaceRenaming}
                onclick={(e) => {
                  e.stopPropagation();
                  removeWorkspace(ws);
                }}
              >
                {#if workspaceRemoving}
                  {@render spinner()}
                {:else}
                  {@render trashIcon()}
                {/if}
              </button>
            {/if}
          </div>
          {#if !collapsed}
            <ul>
              {#each ws.notebooks as nb (nb.id)}
                {@const starting = startingIds.has(nb.id)}
                {@const removing = removingIds.has(nb.id)}
                {@const renaming = renamingIds.has(nb.id)}
                {@const workspaceBusy = workspaceRemoving || workspaceRenaming}
                <li>
                  <div
                    class="group flex items-center gap-1 border-l-2 border-transparent px-3 py-1 pl-10 text-sm transition-colors hover:bg-bg300"
                    class:bg-bg400={starting}
                    class:border-pm500={starting}
                    class:opacity-60={removing || renaming || workspaceBusy}
                    class:opacity-50={!starting && !removing && !renaming && !workspaceBusy && !nb.running}
                  >
                    {#if editingId === nb.id}
                      {#if starting}
                        {@render spinner()}
                      {:else if nb.running}
                        {@render dotActive()}
                      {:else}
                        {@render dotInactive()}
                      {/if}
                      <input
                        use:focusOnMount
                        class="min-w-0 flex-1 rounded border border-bd500 bg-bg100 px-1.5 py-0.5 font-mono text-sm text-tx100 outline-none ring-0 focus:border-pm500 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
                        aria-label={`Rename ${nb.name}`}
                        disabled={renaming}
                        bind:value={editingName}
                        onkeydown={(e) => {
                          if (e.key === 'Enter') saveRename(nb.id, nb.name);
                          if (e.key === 'Escape') cancelRename();
                        }}
                      />
                      <button
                        type="button"
                        class="flex size-6 shrink-0 items-center justify-center rounded text-tx300 hover:bg-bg400 hover:text-pm500 disabled:opacity-50"
                        aria-label={`Save ${nb.name} name`}
                        title="Save"
                        disabled={renaming}
                        onclick={(e) => {
                          e.stopPropagation();
                          saveRename(nb.id, nb.name);
                        }}
                      >
                        {@render checkIcon()}
                      </button>
                      <button
                        type="button"
                        class="flex size-6 shrink-0 items-center justify-center rounded text-tx400 hover:bg-bg400 disabled:opacity-50"
                        aria-label={`Cancel renaming ${nb.name}`}
                        title="Cancel"
                        disabled={renaming}
                        onclick={(e) => {
                          e.stopPropagation();
                          cancelRename();
                        }}
                      >
                        {@render cancelIcon()}
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 text-left"
                        aria-describedby={detailPopover?.id === nb.id ? `notebook-detail-${nb.id}` : undefined}
                        aria-label={starting
                          ? `${nb.name} is starting`
                          : nb.running
                            ? `Preview ${nb.name}`
                            : `Preview ${nb.name}. Double-click to start.`}
                        disabled={starting || removing || renaming || workspaceBusy}
                        onmouseenter={(e) =>
                          scheduleNotebookDetails(
                            nb.id,
                            nb.name,
                            e.currentTarget as HTMLElement,
                            starting || removing || renaming || workspaceBusy,
                            nb.running,
                          )}
                        onmouseleave={scheduleHideNotebookDetails}
                        onfocus={(e) =>
                          scheduleNotebookDetails(
                            nb.id,
                            nb.name,
                            e.currentTarget as HTMLElement,
                            starting || removing || renaming || workspaceBusy,
                            nb.running,
                          )}
                        onblur={hideNotebookDetails}
                        onclick={() => selectFromWorkspace(nb.id)}
                        ondblclick={() => startNotebook(nb.id, nb.running)}
                      >
                        {#if starting}
                          {@render spinner()}
                        {:else if nb.running}
                          {@render dotActive()}
                        {:else}
                          {@render dotInactive()}
                        {/if}
                        <span class="truncate font-mono" class:font-medium={starting}>{nb.name}</span>
                        {#if starting}
                          <span class="ml-auto shrink-0 rounded bg-pm500 px-1.5 py-0.5 text-[11px] font-medium text-white">Starting...</span>
                        {/if}
                      </button>
                      {#if !starting}
                        <button
                          type="button"
                          class="pointer-events-none flex size-6 shrink-0 items-center justify-center rounded text-tx400 opacity-0 transition-opacity hover:bg-bg400 hover:text-tx200 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:opacity-50"
                          aria-label={`Edit ${nb.name} name`}
                          title="Edit name"
                          disabled={removing || renaming || workspaceBusy}
                          onclick={(e) => {
                            e.stopPropagation();
                            beginRename(nb.id, nb.name);
                          }}
                        >
                          {@render editIcon()}
                        </button>
                        <button
                          type="button"
                          class="pointer-events-none flex size-6 shrink-0 items-center justify-center rounded text-tx400 opacity-0 transition-opacity hover:bg-bg400 hover:text-pm500 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:opacity-50"
                          aria-label={`Remove ${nb.name}`}
                          title="Remove"
                          disabled={removing || renaming || workspaceBusy}
                          onclick={(e) => {
                            e.stopPropagation();
                            removeNotebook(nb.id);
                          }}
                        >
                          {@render trashIcon()}
                        </button>
                      {/if}
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
      </div>
    {/if}
  </section>
</aside>

{#if detailPopover}
  {@const detailEntry = detailCache.get(detailPopover.id)}
  <div
    id={`notebook-detail-${detailPopover.id}`}
    role="tooltip"
    class="fixed z-50 w-[300px] rounded border border-bd300 bg-bg100 px-3 py-2 text-xs text-tx200 shadow-lg"
    style:top={`${detailPopover.top}px`}
    style:left={`${detailPopover.left}px`}
    onmouseenter={clearDetailHideTimer}
    onmouseleave={scheduleHideNotebookDetails}
  >
    <div class="mb-2 min-w-0 border-b border-bd300 pb-2">
      <div class="truncate font-mono text-sm font-medium text-tx100">{detailPopover.name}</div>
    </div>

    {#if !detailEntry || detailEntry.status === 'loading'}
      <div class="text-tx400">Loading details...</div>
    {:else if detailEntry.status === 'error'}
      <div class="text-pm500">Details unavailable.</div>
    {:else}
      {@const detail = detailEntry.data}
      <div class="flex flex-col gap-1.5">
        {#if runtimeEditingId === detail.id}
          {@const updatingRuntime = updatingRuntimeIds.has(detail.id)}
          <div class="flex flex-col gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-tx400">Runtime binary</span>
              <input
                class="rounded border border-bd500 bg-bg100 px-1.5 py-1 text-xs text-tx100 outline-none ring-0 focus:border-pm500 focus:outline-none focus:ring-0"
                bind:value={runtimeBinary}
                disabled={updatingRuntime}
              />
            </label>
            {#if detail.type === 'pluto'}
              <label class="flex flex-col gap-1">
                <span class="text-tx400">Julia project</span>
                <input
                  class="rounded border border-bd500 bg-bg100 px-1.5 py-1 text-xs text-tx100 outline-none ring-0 focus:border-pm500 focus:outline-none focus:ring-0"
                  bind:value={runtimeProject}
                  disabled={updatingRuntime}
                />
              </label>
            {/if}
            <div class="flex justify-end gap-1 pt-1">
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded text-tx400 hover:bg-bg300 disabled:opacity-50"
                title="Cancel"
                aria-label="Cancel runtime edit"
                disabled={updatingRuntime}
                onclick={cancelRuntimeEdit}
              >
                {@render cancelIcon()}
              </button>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded text-tx300 hover:bg-bg300 hover:text-pm500 disabled:opacity-50"
                title="Save runtime"
                aria-label="Save runtime"
                disabled={updatingRuntime}
                onclick={(e) => saveRuntime(e, detail)}
              >
                {@render checkIcon()}
              </button>
            </div>
          </div>
        {:else}
          {@render detailLine('Type', detail.type, null)}
          <div class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-tx400">Runtime</span>
            <span class="min-w-0 flex-1 truncate text-right text-tx200" title={detail.runtime.binary}>
              {detail.runtime.binary}
            </span>
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded text-tx400 hover:bg-bg300 hover:text-tx100"
              aria-label="Copy runtime"
              title="Copy runtime"
              onclick={(e) => copyDetailValue(e, `${detail.id}:runtime`, detail.runtime.binary)}
            >
              {#if copiedDetailKey === `${detail.id}:runtime`}
                {@render checkIcon()}
              {:else}
                {@render copyIcon()}
              {/if}
            </button>
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded text-tx400 hover:bg-bg300 hover:text-tx100 disabled:opacity-50"
              aria-label={detail.session ? 'Stop notebook before changing runtime' : 'Edit runtime'}
              title={detail.session ? 'Stop notebook before changing runtime' : 'Edit runtime'}
              disabled={Boolean(detail.session)}
              onclick={(e) => beginRuntimeEdit(e, detail)}
            >
              {@render editIcon()}
            </button>
          </div>
          {#if detail.runtime.project}
            {@render detailLine('Project', detail.runtime.project, `${detail.id}:project`)}
          {/if}
          <div class="flex min-w-0 items-center justify-between gap-3">
            <span class="shrink-0 text-tx400">Status</span>
            <span class={detail.session ? 'text-pm500' : 'text-tx300'}>
              {detail.session ? 'Running' : 'Stopped'}
            </span>
          </div>
          {#if detail.session}
            {@render detailLine('URL', detail.session.url || `localhost:${detail.session.port}`, `${detail.id}:url`)}
          {/if}
          {@render detailLine('Path', detail.path, `${detail.id}:path`)}
        {/if}
      </div>
    {/if}
  </div>
{/if}
