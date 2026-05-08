<script lang="ts">
  let { onresize, sidebarWidth }: {
    onresize: (newWidth: number) => void;
    sidebarWidth: number;
  } = $props();

  let dragStartX = 0;
  let dragStartWidth = 0;

  function handlePointerDown(e: PointerEvent) {
    dragStartX = e.clientX;
    dragStartWidth = sidebarWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - dragStartX;
    onresize(dragStartWidth + dx);
  }

  function handlePointerUp(e: PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }
</script>

<div
  role='separator'
  aria-orientation='vertical'
  class='w-[2px] shrink-0 bg-bd400 cursor-col-resize hover:bg-pm400'
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
></div>
