import { Module } from '@nestjs/common';

/**
 * The worker's composition root.
 *
 * It boots the same modules as the API, as a standalone application: a job handler shares
 * the domain and application layers exactly, so "approve" means one thing whether a person
 * or an escalation timer triggers it. Consumers are registered in Phase 1 alongside the use
 * cases they wrap (`docs/architecture/02-backend-architecture.md` §8).
 */
@Module({})
export class WorkerModule {}
