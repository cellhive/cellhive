// @ts-check
import { readdirSync } from 'node:fs';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WEB_SRC = 'apps/web/src';

/** Feature folders of the web app (FRONTEND §1.2); each may not import another. */
const webFeatures = readdirSync(new URL(`./${WEB_SRC}/features`, import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const DYNAMIC_CODE_IMPORTS = [
  { name: 'vm', message: 'Executing dynamic code is forbidden (AGENTS.md rule 3).' },
  { name: 'node:vm', message: 'Executing dynamic code is forbidden (AGENTS.md rule 3).' },
];

/**
 * AGENTS.md golden rule 2: SQL text is never built from strings. `sql.raw`,
 * `sql.lit` and `CompiledQuery.raw` splice text into a statement unescaped,
 * so they are banned outside the reviewed DDL/connection files below.
 */
/** FRONTEND §9.2 (T322b): a native `title` on a button never shows on keyboard focus. */
const NATIVE_TITLE_SYNTAX = {
  selector: "JSXOpeningElement[name.name=/^(Button|button)$/] > JSXAttribute[name.name='title']",
  message: 'Buttons get a <Tooltip> from @cellhive/ui, not a native title (FRONTEND §9.2).',
};

const RAW_SQL_SYNTAX = [
  {
    selector: "MemberExpression[object.name='sql'][property.name=/^(raw|lit)$/]",
    message:
      'sql.raw/sql.lit splice unescaped SQL (AGENTS.md rule 2): use sql`…` with parameters and sql.id() for identifiers from meta.',
  },
  {
    selector: "MemberExpression[object.name='CompiledQuery'][property.name='raw']",
    message: 'CompiledQuery.raw splices unescaped SQL (AGENTS.md rule 2): use Kysely or sql`…`.',
  },
];

/** The only sources allowed to use raw SQL text: static DDL of migrations and the DDL builders. */
export const RAW_SQL_ALLOWED_FILES = [
  'packages/server-core/src/db/migrations/**',
  'packages/server-core/src/schema/physical.ts',
  'packages/server-core/src/schema/schema.service.ts',
  'packages/server-core/src/db/create-db.ts',
];

const BROWSER_IMPORT_PATTERNS = [
  { group: ['node:*'], message: 'Browser code cannot use Node built-ins.' },
];

/** FRONTEND §1.3: glide-data-grid is used only through the adapter in `apps/web/src/grid`. */
const GLIDE_MESSAGE = 'Only apps/web/src/grid may use the grid library (FRONTEND §1.3).';
const GLIDE_IMPORTS = {
  paths: [{ name: '@glideapps/glide-data-grid', message: GLIDE_MESSAGE }],
  patterns: [{ group: ['@glideapps/glide-data-grid/*'], message: GLIDE_MESSAGE }],
};

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '.agents/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    // TypeScript already resolves imports; import-x only enforces ordering and duplicates.
    plugins: { 'import-x': importX },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // AGENTS.md: logging goes through the injected pino Logger only.
      'no-console': 'error',
      // AGENTS.md golden rule 3: no eval, new Function or vm.
      'no-eval': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vm', message: 'Executing dynamic code is forbidden (AGENTS.md rule 3).' },
            { name: 'node:vm', message: 'Executing dynamic code is forbidden (AGENTS.md rule 3).' },
          ],
        },
      ],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',
      // NestJS modules are decorated classes without members.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      'no-restricted-syntax': ['error', ...RAW_SQL_SYNTAX],
    },
  },
  {
    files: RAW_SQL_ALLOWED_FILES,
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Runs in browsers too: no Node built-ins, no server frameworks or drivers.
    files: [
      'packages/field-types/src/**/*.ts',
      'packages/filter-dsl/src/**/*.ts',
      'packages/formula-engine/src/**/*.ts',
      'packages/markdown/src/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vm', message: 'Executing dynamic code is forbidden (AGENTS.md rule 3).' },
            { name: 'node:vm', message: 'Executing dynamic code is forbidden (AGENTS.md rule 3).' },
            { name: 'pg', message: 'This package must stay browser-safe.' },
          ],
          patterns: [
            { group: ['node:*'], message: 'This package must stay browser-safe.' },
            { group: ['@nestjs/*'], message: 'This package must stay browser-safe.' },
          ],
        },
      ],
    },
  },
  {
    // Browser code: the web app and the shared UI components.
    files: [`${WEB_SRC}/**/*.{ts,tsx}`, 'packages/ui/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    settings: {
      'import-x/resolver-next': [createNodeResolver({ extensions: ['.ts', '.tsx', '.js'] })],
    },
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      'react-hooks/exhaustive-deps': 'error',
      // React Router loaders throw `redirect()` / `data()` responses by design.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'lib', name: 'Response' },
            { from: 'package', package: 'react-router', name: 'DataWithResponseInit' },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [...DYNAMIC_CODE_IMPORTS, ...GLIDE_IMPORTS.paths],
          patterns: [...BROWSER_IMPORT_PATTERNS, ...GLIDE_IMPORTS.patterns],
        },
      ],
      // FRONTEND §12: no raw HTML injection outside the (future) Markdown component.
      'no-restricted-syntax': [
        'error',
        ...RAW_SQL_SYNTAX,
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Use the sanitising Markdown component (FRONTEND §12).',
        },
        NATIVE_TITLE_SYNTAX,
      ],
    },
  },
  {
    // The grid adapter (FRONTEND §1.3) is the one place allowed to import glide-data-grid.
    files: [`${WEB_SRC}/grid/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: DYNAMIC_CODE_IMPORTS, patterns: BROWSER_IMPORT_PATTERNS },
      ],
    },
  },
  {
    // FRONTEND §1.2: a feature never imports another feature; `lib/` never
    // imports features or the app layer.
    files: [`${WEB_SRC}/**/*.{ts,tsx}`],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            ...webFeatures.map((feature) => ({
              target: `./${WEB_SRC}/features/${feature}`,
              from: `./${WEB_SRC}/features`,
              except: [`./${feature}`],
              message: 'Features may not import each other; share through lib/ or @cellhive/ui.',
            })),
            {
              target: `./${WEB_SRC}/lib`,
              from: [`./${WEB_SRC}/features`, `./${WEB_SRC}/app`, `./${WEB_SRC}/grid`],
              message: 'lib/ is shared by every feature and may not depend on them.',
            },
            {
              target: `./${WEB_SRC}/grid`,
              from: [`./${WEB_SRC}/features`, `./${WEB_SRC}/app`],
              message:
                'The grid adapter (FRONTEND §1.3) is used by features; it depends only on lib/ and packages.',
            },
            {
              target: `./${WEB_SRC}/features`,
              from: `./${WEB_SRC}/app`,
              message: 'Features may not import the app layer.',
            },
          ],
        },
      ],
    },
  },
  {
    // SPEC §18 / FRONTEND §9.1: every UI string goes through i18n.
    files: [`${WEB_SRC}/**/*.{ts,tsx}`, 'packages/ui/src/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          // Defaults of the plugin plus router navigation (paths are not UI text).
          callees: {
            exclude: [
              'i18n(ext)?',
              't',
              'require',
              'addEventListener',
              'removeEventListener',
              'postMessage',
              'getElementById',
              'dispatch',
              'commit',
              'includes',
              'indexOf',
              'endsWith',
              'startsWith',
              'navigate',
            ],
          },
          'jsx-attributes': {
            exclude: [
              'className',
              'styleName',
              'style',
              'width',
              'height',
              'type',
              'key',
              'id',
              'to',
              'href',
              'rel',
              'target',
              'name',
              'value',
              'autoComplete',
              'inputMode',
              'htmlFor',
              'role',
              'variant',
              'size',
              'side',
              'align',
              'lang',
              'method',
              'viewBox',
              'd',
              'fill',
              'stroke',
              'strokeWidth',
              'strokeLinecap',
              'strokeLinejoin',
              'aria-hidden',
              'aria-controls',
              'aria-current',
              'aria-live',
              'data-.*',
            ],
          },
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
