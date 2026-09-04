import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'build/**', 'test/smoke/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // stdout is the MCP JSON-RPC channel; anything printed there corrupts the protocol.
      'no-console': ['error', { allow: ['error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
