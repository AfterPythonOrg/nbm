<script lang="ts">
	import Sidebar from '$components/Sidebar.svelte';
	import NotebookView from '$components/NotebookView.svelte';
  import NotebookPreview from '$components/NotebookPreview.svelte';
  import Resizer from '$components/Resizer.svelte';
  import ThemeToggle from '$components/ThemeToggle.svelte';
  import SidebarToggle from '$components/SidebarToggle.svelte';
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import type { Mode } from '@nbm/core';
  import type { KeybindingsDTO, NotebooksResponse, RunningItemDTO } from '$lib/api';
  import { tabStore } from '$lib/stores/tabs.svelte';
  import { previewStore } from '$lib/stores/preview.svelte';

  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_MAX_WIDTH = 600;
  const SIDEBAR_DEFAULT_WIDTH = 240;
  const WIDTH_KEY = 'nbm:sidebar-width';
  const COLLAPSED_KEY = 'nbm:sidebar-collapsed';

  function loadInitialWidth(): number {
    if (!browser) return SIDEBAR_DEFAULT_WIDTH;
    const stored = localStorage.getItem(WIDTH_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH;
  }

  function loadInitialCollapsed(): boolean {
    if (!browser) return false;
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  }

  let sidebarWidth = $state(loadInitialWidth());
  let collapsed = $state(loadInitialCollapsed());
  let mode = $state<Mode | null>(null);
  let running = $state<RunningItemDTO[]>([]);
  let keybindings = $state<KeybindingsDTO>({
    nextRunningKeybinding: 'Alt+J',
    previousRunningKeybinding: 'Alt+K',
  });
  let openedInitialNotebook = false;

  $effect(() => {
    if (!browser) return;
    localStorage.setItem(WIDTH_KEY, String(sidebarWidth));
  });

  $effect(() => {
    if (!browser) return;
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  });

  function handleResize(newWidth: number) {
    sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, newWidth));
  }

  onMount(() => {
    if (!browser) return;
    loadNotebooks();
    window.addEventListener('keydown', handleGlobalKeydown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown, { capture: true });
    };
  });

  // On initial load in embedded mode, open the most recently started running
  // notebook (the API sorts `running` by startedAt desc). This replaces the
  // old `?nb=` URL handoff so the UI URL stays clean. Sidebar.svelte already
  // polls /api/notebooks, so we only refetch on shortcut press to keep the
  // running list fresh enough for cycling without doubling the poll traffic.
  async function loadNotebooks() {
    const res = await fetch('/api/notebooks');
    if (!res.ok) return;
    const data = (await res.json()) as NotebooksResponse;
    mode = data.mode;
    running = data.running;
    keybindings = data.keybindings;
    if (openedInitialNotebook || mode !== 'embedded') return;

    const first = data.running[0];
    if (first) tabStore.openTab(first.id);
    openedInitialNotebook = true;
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    if (matchesKeybinding(e, keybindings.nextRunningKeybinding)) {
      e.preventDefault();
      cycleRunningNotebook(1);
      loadNotebooks();
      return;
    }
    if (matchesKeybinding(e, keybindings.previousRunningKeybinding)) {
      e.preventDefault();
      cycleRunningNotebook(-1);
      loadNotebooks();
    }
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    );
  }

  function cycleRunningNotebook(direction: 1 | -1) {
    if (running.length === 0) return;
    if (mode === 'embedded') previewStore.clear();

    const activeId = mode === 'embedded' ? tabStore.activeId : previewStore.selectedId;
    const currentIndex = activeId ? running.findIndex((nb) => nb.id === activeId) : -1;
    const nextIndex =
      currentIndex < 0
        ? direction === 1
          ? 0
          : running.length - 1
        : (currentIndex + direction + running.length) % running.length;
    const nextId = running[nextIndex].id;

    if (mode === 'embedded') {
      tabStore.openTab(nextId);
      return;
    }
    previewStore.select(nextId);
  }

  function matchesKeybinding(event: KeyboardEvent, keybinding: string): boolean {
    const parts = keybinding
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const key = parts.at(-1);
    if (!key) return false;

    const wantsAlt = parts.some((part) => part === 'alt' || part === 'opt' || part === 'option');
    const wantsCtrl = parts.some((part) => part === 'ctrl' || part === 'control');
    const wantsMeta = parts.some((part) => part === 'cmd' || part === 'command' || part === 'meta');
    const wantsShift = parts.includes('shift');
    return (
      eventKeyMatches(event, key) &&
      event.altKey === wantsAlt &&
      event.ctrlKey === wantsCtrl &&
      event.metaKey === wantsMeta &&
      event.shiftKey === wantsShift
    );
  }

  function eventKeyMatches(event: KeyboardEvent, key: string): boolean {
    if (key.length === 1 && /^[a-z0-9]$/.test(key)) {
      return event.code.toLowerCase() === `key${key}` || event.code.toLowerCase() === `digit${key}`;
    }
    return event.key.toLowerCase() === key;
  }
</script>

<div class="relative flex h-screen w-screen overflow-hidden bg-bg100 text-tx100">
  {#if !collapsed}
    <div class="relative shrink-0" style="width: {sidebarWidth}px">
      <Sidebar />
      <div class="absolute right-2 top-0 z-10">
        <SidebarToggle {collapsed} onclick={() => (collapsed = true)} />
      </div>
    </div>
    <Resizer onresize={handleResize} {sidebarWidth} />
  {/if}
  <div class="relative flex-1 min-w-0">
    {#if mode === 'embedded'}
      <!--
        Always keep NotebookView mounted so its iframes are never destroyed
        (destroying an iframe drops the Marimo websocket and forces a reconnect).
        NotebookPreview is layered on top via absolute positioning when the user
        clicks a workspace row; clicking a Running row clears previewStore,
        hiding the overlay and revealing the iframes underneath.
      -->
      <NotebookView />
      {#if previewStore.selectedId}
        <div class="absolute inset-0 z-10">
          <NotebookPreview />
        </div>
      {/if}
    {:else if mode === 'standalone'}
      <NotebookPreview />
    {/if}
    {#if collapsed}
      <div class="absolute left-2 top-2 z-10">
        <SidebarToggle {collapsed} onclick={() => (collapsed = false)} />
      </div>
    {/if}
  </div>
  <div class="absolute bottom-2 left-2 z-20">
    <ThemeToggle />
  </div>
</div>
