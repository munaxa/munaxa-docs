import { Inject, Injectable } from '@nestjs/common';

import { type ReportDefinitionId, type UserId, asId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import {
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { reportFor } from '../domain/report-catalogue';
import { parseParameters } from '../domain/report-parameters';
import {
  REPORT_DEFINITION_REPOSITORY,
  type ReportDefinitionRecord,
  type ReportDefinitionRepository,
} from './ports';

/**
 * Saved reports — `REPORT_DEFINITION_REPOSITORY`, bound at last.
 *
 * ## What a definition is, and the one thing it is not
 *
 * A name, a catalogue key, and a parameter map. **Never a query.** That is the enforcement of the
 * constraint `ports.ts` opens with — *"reports read from read models, never from another module's
 * tables … that constraint is what keeps a reporting query from quietly becoming the reason a
 * schema cannot change"* — and it is enforced by the shape rather than by review: there is no field
 * on `ReportDefinitionRecord`, on `report_definition` or on the wire that could hold SQL, a column
 * list or a table name. A tenant that could author a query would be a tenant that could pin a
 * column, and no migration would ever again be a decision this repository alone could take.
 *
 * ## Why the parameters are validated on the way in
 *
 * A saved definition outlives the screen that created it. Storing whatever was posted would mean a
 * definition that runs today and fails in six months because a parameter was misspelled and nobody
 * noticed until somebody ran it — or, worse, one that *succeeds* with the misspelled filter dropped
 * and reports over more rows than its name implies. So it is parsed against the catalogue before it
 * is stored, exactly as it would be on the way to a query.
 *
 * ## Personal, and enforced by absence
 *
 * A definition belongs to whoever made it. No route under `/reports/definitions` takes an owner, so
 * "read somebody else's saved reports" is not a request this API can express — the same
 * enforcement-by-absence the notification, delegation and dashboard controllers use. It matters
 * more here than it looks: a saved definition over the deleted-documents report is a record of what
 * somebody has been looking for.
 *
 * ## `report:manage` is not bound by this, and that is stated rather than left to be noticed
 *
 * 08 §6 gives `report:manage` to the tenant administrator and the document controller only, which
 * is the shape of a permission for *shared* definitions — a report the tenant offers everybody
 * rather than one a person keeps. Nothing here shares one, so nothing here needs it. Binding it to
 * personal definitions would be the wrong reading and would put an author's own saved filter behind
 * a permission 08 §6 does not give them. The phase report names it as owed.
 */
@Injectable()
export class ReportDefinitionService {
  constructor(
    @Inject(REPORT_DEFINITION_REPOSITORY) private readonly definitions: ReportDefinitionRepository,
    private readonly writer: AdministeredWriter,
  ) {}

  listForCaller(page: PageRequest): Promise<Page<ReportDefinitionRecord>> {
    return this.writer.read(() => this.definitions.listFor(this.caller(), page));
  }

  async save(
    key: string,
    name: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<ReportDefinitionRecord> {
    const report = reportFor(key);
    if (report === null) {
      throw new NotFoundError('The requested resource');
    }
    const parsed = parseParameters(report, parameters);
    if (!parsed.ok) {
      throw new ValidationError('This report cannot be saved with those parameters.', [
        ...parsed.errors,
      ]);
    }

    const owner = this.caller();
    const record: ReportDefinitionRecord = {
      id: asId<ReportDefinitionId>(this.writer.clock.nextId()),
      key,
      name,
      ownerId: owner,
      // What was supplied, minus the reserved `format` — a saved *definition* is a query, and the
      // format is a property of one export of it. Storing the format would make "save this view"
      // and "save this download" the same thing, and they are not.
      query: parsed.parameters.supplied,
    };

    // No audit row. 13 §2 gives this phase one action and it is spent on the export, which is what
    // produces a file that leaves the product. Saving a set of filters for oneself changes nothing
    // anybody else can observe — the same reasoning that gives a saved *search* no audit row.
    await this.writer.read(() => this.definitions.save(record));
    return record;
  }

  async remove(id: ReportDefinitionId): Promise<void> {
    const existing = await this.writer.read(() => this.definitions.findById(id));
    // A definition belonging to somebody else is a `404` rather than a `403`: 08 §7's rule, and it
    // applies here because the existence of a saved report is itself a fact about what that person
    // has been looking at.
    if (existing === null || existing.ownerId !== this.caller()) {
      throw new NotFoundError('The requested resource');
    }
    await this.writer.read(() => this.definitions.softDelete(id));
  }

  private caller(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new UnauthenticatedError('This request has no user behind it.');
    }
    return userId;
  }
}
