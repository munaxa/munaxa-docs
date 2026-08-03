import { Global, Module } from '@nestjs/common';

import { type AppConfig, loadConfig } from './configuration';

/** The token every consumer injects. Nothing reads `process.env` outside this module. */
export const APP_CONFIG = Symbol('AppConfig');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
