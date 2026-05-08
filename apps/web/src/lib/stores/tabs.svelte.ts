import type { NotebookDetailResponse } from '$lib/api';

export type Tab = {
  id: string;
  name: string;
  url: string;
  loaded: boolean;
};

class TabStore {
  tabs = $state<Tab[]>([]);
  activeId = $state<string | null>(null);

  /**
   * Open (or activate) a tab for the given notebook.
   * Fetches the notebook's current session URL from the API. A notebook keeps
   * the same id across restarts, but its runtime URL/token can change.
   */
  async openTab(notebookId: string): Promise<void> {
    try {
      const res = await fetch(`/api/notebooks/${notebookId}`);
      if (!res.ok) {
        console.warn(`openTab: HTTP ${res.status} for ${notebookId}`);
        return;
      }
      const data = (await res.json()) as NotebookDetailResponse;
      if (!data.session) {
        console.warn(`openTab: notebook ${notebookId} has no active session`);
        return;
      }

      const existing = this.tabs.find((t) => t.id === notebookId);
      const nextTab = {
        id: notebookId,
        name: data.name,
        url: data.session.url,
        loaded: existing?.url === data.session.url ? existing.loaded : false,
      };

      this.tabs = existing
        ? this.tabs.map((tab) => (tab.id === notebookId ? nextTab : tab))
        : [...this.tabs, nextTab];
      this.activeId = notebookId;
    } catch (e) {
      console.error('openTab failed:', e);
    }
  }

  closeTab(notebookId: string): void {
    const idx = this.tabs.findIndex((t) => t.id === notebookId);
    if (idx < 0) return;
    this.tabs = this.tabs.filter((t) => t.id !== notebookId);
    if (this.activeId === notebookId) {
      this.activeId = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null;
    }
  }

  setActive(notebookId: string): void {
    if (this.tabs.some((t) => t.id === notebookId)) {
      this.activeId = notebookId;
    }
  }

  markLoaded(notebookId: string): void {
    const tab = this.tabs.find((t) => t.id === notebookId);
    if (tab) tab.loaded = true;
  }
}

export const tabStore = new TabStore();
