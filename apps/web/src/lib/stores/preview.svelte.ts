class PreviewStore {
  selectedId = $state<string | null>(null);

  select(notebookId: string): void {
    this.selectedId = notebookId;
  }

  clear(): void {
    this.selectedId = null;
  }
}

export const previewStore = new PreviewStore();
