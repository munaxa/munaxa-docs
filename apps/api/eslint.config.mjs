import base from '@munaxa/config-eslint/nest.js';

/**
 * Layer and module boundaries, enforced rather than described.
 *
 * The dependency rule points inward: presentation and infrastructure depend on application,
 * application depends on domain, and domain depends on nothing but pure packages
 * (`docs/architecture/01-monorepo-and-folder-structure.md` §3). Cross-module calls go
 * through the owning module's application service or a domain event.
 */
const INWARD_ONLY = ['../application/**', '../infrastructure/**', '../presentation/**'];
const INWARD_ONLY_NESTED = [
  '../../application/**',
  '../../infrastructure/**',
  '../../presentation/**',
];
const OTHER_MODULE_INTERNALS = [
  '../*/domain/**',
  '../*/infrastructure/**',
  '../*/presentation/**',
  '../../*/domain/**',
  '../../*/infrastructure/**',
  '../../*/presentation/**',
  '../../../*/domain/**',
  '../../../*/infrastructure/**',
  '../../../*/presentation/**',
];

export default [
  ...base,
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@prisma/*', 'prisma', 'express', 'ioredis', 'bullmq'],
              message:
                'The domain layer is pure: no framework, no persistence, no transport. This belongs in application/ or infrastructure/.',
            },
            {
              group: [...INWARD_ONLY, ...INWARD_ONLY_NESTED],
              message: 'The domain layer may not depend on the layers above it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/*', 'prisma', 'express', 'ioredis', 'bullmq'],
              message:
                'The application layer declares ports; it never names an adapter or a persistence library.',
            },
            {
              group: ['../infrastructure/**', '../presentation/**', ...INWARD_ONLY_NESTED],
              message: 'The application layer may not depend on the layers above it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: OTHER_MODULE_INTERNALS,
              message:
                "Cross-module calls go through the owning module's application service or a domain event — never into its internals.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/ports/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../modules/**', '../../modules/**', '../../../modules/**'],
              message:
                'Core and ports are imported by every module and may never depend on one. Invert the dependency.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.spec.ts'],
    rules: {
      /**
       * `unbound-method` fires on every `expect(double.method).toHaveBeenCalled()`, because it
       * cannot tell a reference that will be invoked from one that is only being inspected.
       * The assertion never calls the method, so there is no `this` to lose. Disabled for
       * tests only — the rule keeps its teeth everywhere it can catch a real defect.
       */
      '@typescript-eslint/unbound-method': 'off',
    },
  },
];
