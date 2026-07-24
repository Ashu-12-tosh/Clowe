import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/**'],
  rules: {
    // Underscore-prefixed params are intentionally unused (e.g. Express
    // error handlers must keep the 4-arg signature).
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
});
