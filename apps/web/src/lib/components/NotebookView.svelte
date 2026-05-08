<script lang="ts">
  import { tabStore } from '$lib/stores/tabs.svelte';
</script>

<div class="flex h-full w-full flex-col bg-bg100">
  <div class="relative min-h-0 flex-1">
    {#if tabStore.tabs.length === 0}
      <div class="flex h-full items-center justify-center text-tx400">
        <div class="text-center">
          <p class="text-base">No notebook open.</p>
          <p class="mt-1 text-sm">Pick one from the sidebar, or run <code class="rounded bg-bg300 px-1 py-0.5">nbm start &lt;file&gt;</code> in your terminal.</p>
        </div>
      </div>
    {:else}
      <!--
        All iframes stay mounted; only the active one is visible. This preserves
        each notebook's runtime state when switching tabs (no reload, no lost
        connection). Trade-off: memory grows with open tabs.
      -->
      {#each tabStore.tabs as tab (tab.id)}
        <iframe
          src={tab.url}
          title={tab.name}
          class="absolute inset-0 h-full w-full border-0"
          class:hidden={tab.id !== tabStore.activeId}
          onload={() => tabStore.markLoaded(tab.id)}
        ></iframe>
      {/each}
    {/if}
  </div>
</div>
