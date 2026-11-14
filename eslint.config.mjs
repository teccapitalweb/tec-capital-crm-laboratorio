// Revisión estática (npm run lint, y un paso de npm run check). Pocas reglas y de señal alta: erratas, código
// muerto, flujo roto y las reglas del proyecto que hasta ahora sólo vigilaba una persona (transacciones de SQLite
// y HTML sin escapar en las pantallas nuevas). Formato: Prettier, no ESLint.
import js from '@eslint/js';
import globals from 'globals';

// CLAUDE.md: transaction() es síncrona, no se anida y no lleva red dentro.
const invariantes = [
  {
    selector: "CallExpression[callee.name='transaction'] > :function[async=true]",
    message: 'transaction() no admite funciones asíncronas (CLAUDE.md).',
  },
  {
    selector: "CallExpression[callee.name='transaction'] > :function AwaitExpression",
    message: 'Nada de await dentro de transaction().',
  },
  {
    selector: "CallExpression[callee.name='transaction'] CallExpression[callee.name='fetch']",
    message: 'Nada de red dentro de transaction().',
  },
  {
    selector: "CallExpression[callee.name='transaction'] CallExpression[callee.name='transaction']",
    message: 'transaction() no se anida.',
  },
];
// Pantallas nuevas: el HTML sólo se pinta con render(el, html`…`) del kit, que escapa todo.
const sinHtmlCrudo = [
  {
    selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]",
    message: 'En pantallas nuevas el HTML se pinta con render(el, html`…`) del kit.',
  },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Usa render() del kit.' },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
    message: 'document.write no se usa.',
  },
];
const base = {
  ...js.configs.recommended.rules,
  'no-control-regex': 'off', // /[\x00-\x1f]/ se usa a propósito para limpiar textos
  'no-useless-escape': 'off', // estilo, sin valor aquí
  'no-empty': ['error', { allowEmptyCatch: true }],
  // «let x = null; try { x = … } catch { … }» es un patrón deliberado del proyecto, no un error.
  'no-useless-assignment': 'off',
  'no-unused-vars': [
    'error',
    { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
  ],
  'no-restricted-syntax': ['error', ...invariantes],
};

export default [
  {
    ignores: [
      'node_modules/',
      'data/',
      'data-demo/',
      'public/vendor/',
      'public/flyers/',
      'test/fixtures/',
      '.claude/',
      'playwright-report/',
      'test-results/',
    ],
  },
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: base,
  },
  // Las pruebas de navegador ejecutan funciones dentro de la página (page.evaluate): también ven el navegador.
  { files: ['test/ui/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // Los guiones actuales del navegador: guiones clásicos que se comunican por window.createXUI.
  {
    files: ['public/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, lucide: 'readonly' },
    },
    rules: base,
  },
  { files: ['public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  // Trinquete del código heredado (raíz de server/ y public/, y pruebas): lo que no es un error real queda como
  // aviso, con un tope (npm run lint, --max-warnings) que sólo puede bajar. Lo nuevo (server/app, server/lib,
  // server/modules, server/migrations, public/kit, public/screens, scripts) es error desde el primer día.
  {
    files: ['server/*.mjs', 'public/*.js', 'test/*.mjs'],
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-constant-condition': 'warn',
      'no-self-assign': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  // Código nuevo del navegador: módulos ES y HTML sólo a través del kit.
  {
    files: ['public/kit/**/*.js', 'public/screens/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules: { ...base, 'no-restricted-syntax': ['error', ...invariantes, ...sinHtmlCrudo] },
  },
  { files: ['public/kit/html.js'], rules: { 'no-restricted-syntax': ['error', ...invariantes] } }, // el único sitio que toca innerHTML
  // Migraciones con nombre: nunca tocan el número de la escalera.
  {
    files: ['server/migrations/named/**/*.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantes,
        {
          selector: 'Literal[value=/user_version\\s*=/]',
          message: 'Una migración con nombre no cambia PRAGMA user_version.',
        },
        {
          selector: 'TemplateElement[value.raw=/user_version\\s*=/]',
          message: 'Una migración con nombre no cambia PRAGMA user_version.',
        },
      ],
    },
  },
];
