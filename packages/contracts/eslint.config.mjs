import base from '@munaxa/config-eslint/base.js';

/** Contracts are shapes. A contract that imports a framework has stopped being a contract. */
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
              group: ['@nestjs/*', '@prisma/*', 'prisma', 'express', 'next', 'react'],
              message:
                '@edms/contracts is consumed by the API and the browser alike; it may depend only on zod, @edms/domain and @edms/utils.',
            },
          ],
        },
      ],
    },
  },
];
