import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    include: [
      'src/utils/tests/agent-shim.test.ts',
      'src/utils/tests/mcp-tool-name.test.ts',
      'src/utils/tests/tool-search-shim.test.ts',
      'dist/utils/tests/agent-shim.test.js',
      'dist/utils/tests/mcp-tool-name.test.js',
      'dist/utils/tests/tool-search-shim.test.js',
    ],
    exclude: ['**/node_modules/**'],
  }
});