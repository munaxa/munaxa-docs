import base from '@munaxa/config-eslint/base.js';

/** `@edms/domain` is pure. Nothing here may reach for a framework, a database or the network. */
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
              group: [
                '@nestjs/*',
                '@prisma/*',
                'prisma',
                'express',
                'next',
                'react',
                'ioredis',
                'bullmq',
                '@edms/contracts',
                '@edms/i18n',
              ],
              message:
                '@edms/domain is pure. It may not depend on a framework, a client library or another @edms package except @edms/utils.',
            },
          ],
        },
      ],
    },
  },
];
