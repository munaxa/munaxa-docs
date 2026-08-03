import base from '@munaxa/config-eslint/base.js';

/** `@edms/utils` holds helpers with no domain meaning. A helper that knows about documents
 *  belongs to the module that owns the concept, not here. */
export default [
  ...base,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@prisma/*', 'next', 'react', '@edms/*'],
              message: '@edms/utils is a leaf package: it depends on nothing in this repository.',
            },
          ],
        },
      ],
    },
  },
];
