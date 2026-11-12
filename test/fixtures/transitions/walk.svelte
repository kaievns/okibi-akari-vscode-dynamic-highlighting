<script module lang="ts">
  export const LIMIT = 10;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import * as fmt from './fmt';
  import Child from './Child.svelte';

  let { start = 0, label, items = [] }: { start?: number; label: string; items?: { id: number; name: string }[] } = $props();
  let count = $state(start);
  let doubled = $derived(count * 2);
  let changes = 0;
  const promise = Promise.resolve(42);

  function bump(step: number) {
    const next = count + step;
    if (next > LIMIT) return;
    count = next;
    changes += 1;
  }

  $effect(() => {
    console.log(`count ${count}`);
  });

  function tooltip(node: HTMLElement, text: string) {
    node.title = text;
    node.onblur = function () { this.title = ''; };
    return { destroy() {} };
  }

  onMount(() => bump(1));
</script>

<!-- Don't paint this comment; 42 is not a number -->
<h1 class:hot={count > 5}>{label}: {count} ({fmt.twice(doubled)})</h1>

{#if count === 0}
  <p>Nothing yet, it's 0.</p>
{:else if count < LIMIT}
  <p>Count is {count} of 10.</p>
{:else}
  <p>Full</p>
{/if}

<ul>
  {#each items as item, i (item.id)}
    {@const label2 = `${i}: ${item.name}`}
    <li on:click={() => bump(i + 1)}>{label2}</li>
  {:else}
    <li>none</li>
  {/each}
</ul>

{#await promise}
  <p>waiting</p>
{:then value}
  <p>{value}</p>
{:catch error}
  <p>{error.message}</p>
{/await}

{#key count}<span>{count}</span>{/key}

<button onclick={() => bump(1)} disabled={count >= LIMIT} use:tooltip={'add one'}>+1</button>
<input bind:value={count} type="number" />
<Child value={count} {...$$restProps} on:change={(e) => bump(e.detail)} />
{@html `<b>${count}</b>`}

<style>
  h1 { color: #3a7bd5; margin: 4px; } /* a note */
  .hot { font-weight: 700; }
</style>
