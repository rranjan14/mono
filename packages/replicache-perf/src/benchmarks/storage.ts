import type {Benchmark} from '../benchmark.ts';
import {randomString} from '../data.ts';

export function benchmarks(): Benchmark[] {
  return [localStorageRead(), localStorageWrite()];
}

function localStorageRead() {
  return {
    name: 'localStorage read',
    group: 'storage',
    key: '',
    value: <string | null>null,
    setup() {
      this.key = randomString(36);
      localStorage.setItem(this.key, randomString(100));
    },
    teardown() {
      localStorage.removeItem(this.key);
    },
    run() {
      // Assign to ensure this read isn't optimized away.
      this.value = localStorage.getItem(this.key);
    },
  };
}

function localStorageWrite() {
  return {
    name: 'localStorage write',
    group: 'storage',
    key: '',
    value: '',
    setup() {
      this.key = randomString(36);
      this.value = randomString(100);
    },
    teardown() {
      localStorage.removeItem(this.key);
    },
    run() {
      localStorage.setItem(this.key, this.value);
    },
  };
}
