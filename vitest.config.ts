import {defineConfig} from 'vitest/config';
export default defineConfig({test: {include: ['tests-ts/**/*.test.ts'], testTimeout: 10000}});
