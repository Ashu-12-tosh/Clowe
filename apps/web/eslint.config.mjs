// ESLint CLI with flat config, as Next 15 recommends in place of `next lint`
// (deprecated, and gone in Next 16). Next's own rules still come from
// eslint-config-next, read through FlatCompat.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXOpeningElement[name.name=/^(a|Link)$/] > JSXAttribute[name.name='href'] > JSXExpressionContainer > :not(Literal, TemplateLiteral:not([quasis.0.value.raw='']), CallExpression[callee.name='safeHref'], LogicalExpression[left.callee.name='safeHref'], ConditionalExpression[consequent.type=/Literal$/][alternate.type=/Literal$/])",
          message:
            'A computed href must not come straight from data: a stored javascript: or data: URL runs script when clicked. Use <ExternalLink href> for outside links, or wrap it in safeHref() from @clowe/shared.',
        },
      ],
    },
  },
];

export default config;
