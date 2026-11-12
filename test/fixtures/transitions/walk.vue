<script lang="ts">
export const LIMIT = 10;
</script>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import * as fmt from './fmt';
import Child from './Child.vue';

const props = defineProps<{ start?: number; label: string }>();
const emit = defineEmits<{ (e: 'change', value: number): void }>();
const count = ref(props.start ?? 0);
const items = ref([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]);
const doubled = computed(() => count.value * 2);
let changes = 0;

function bump(step: number) {
  const next = count.value + step;
  if (next > LIMIT) return;
  count.value = next;
  changes += 1;
  emit('change', next);
}

function label(this: { name: string }) {
  return this.name;
}

watch(count, (now, before) => {
  console.log(`count ${before} -> ${now}`);
});
</script>

<template>
  <!-- Don't paint this comment; 42 is not a number -->
  <div class="counter" :data-limit="LIMIT" :class="{ hot: count > 5 }">
    <h1>{{ props.label }}: {{ count }} ({{ fmt.twice(doubled) }})</h1>
    <p v-if="count === 0">Nothing yet, it's 0.</p>
    <p v-else-if="count < LIMIT">Count is {{ count }} of 10.</p>
    <p v-else>Full</p>
    <ul>
      <li v-for="(item, i) in items" :key="item.id" @click="bump(i + 1)">{{ i }}: {{ item.name }}</li>
    </ul>
    <button @click="bump(1)" :disabled="count >= LIMIT">+1</button>
    <button v-on:click.prevent="count = 0">reset</button>
    <input v-model.number="count" v-bind:title="`count ${count}`" />
    <Child :value="count" v-bind="$attrs" @change="(v: number) => bump(v)">
      <template #header="{ title }">
        <strong>{{ title.toUpperCase() }}</strong>
      </template>
      <template v-slot:default>default slot</template>
    </Child>
  </div>
</template>

<style scoped>
.counter { color: #3a7bd5; margin: 4px; } /* a note */
.counter h1 { font-size: 2em; }
</style>

<style lang="scss">
$gap: 4px;
.counter { ul { gap: $gap; } }
</style>
