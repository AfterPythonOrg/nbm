<script lang="ts">
  let { collapsed, onclick }: { collapsed: boolean; onclick: () => void } = $props();
</script>

<button
  {onclick}
  class="flex h-8 w-8 items-center justify-center rounded-md text-tx300 transition-all hover:bg-bg300 hover:text-tx100"
  aria-label={collapsed ? 'Open sidebar' : 'Close sidebar'}
  title={collapsed ? 'Open sidebar' : 'Close sidebar'}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    stroke-width="1.5"
    stroke="currentColor"
    class="h-5 w-5"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M9 3v18" />
    {#if collapsed}
      <path stroke-linecap="round" stroke-linejoin="round" d="m14 9 3 3-3 3" />
    {:else}
      <path stroke-linecap="round" stroke-linejoin="round" d="m16 15-3-3 3-3" />
    {/if}
  </svg>
</button>
