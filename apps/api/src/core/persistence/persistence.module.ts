import { Global, Module } from '@nestjs/common';

import { AdministeredWriter } from './administered-writer';
import { RecordStamps } from './record-stamps';

/**
 * The write-side pieces every administered resource shares.
 *
 * Global, for the same reason audit and settings are: stamping a row with who did it and when is
 * cross-cutting, and a module that had to remember to import it is a module that will eventually
 * forget and write a row with no actor.
 *
 * Only the two collaborators that need dependencies are providers. The rest of this directory — the
 * optimistic-lock checks and the list-query helpers — is pure functions, which is why they are
 * imported directly and are unit-testable without a container at all.
 */
@Global()
@Module({
  providers: [RecordStamps, AdministeredWriter],
  exports: [RecordStamps, AdministeredWriter],
})
export class PersistenceModule {}
