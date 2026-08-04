import { Inject, Injectable } from '@nestjs/common';

import { ScopeType, type AnyId, asId } from '@edms/domain';

import {
  CONFIGURATION_SERVICE,
  type MetadataFieldRow,
} from '../../administration/application/administration.ports';
import type { ConfigurationService } from '../../administration/application/configuration.service';
import {
  ORGANIZATION_SERVICE,
  type OrganizationService,
} from '../../organization/application/ports';
import { USER_ADMIN_SERVICE } from '../../identity/application/administration.ports';
import type { UserAdminService } from '../../identity/application/user-admin.service';
import type { FieldDefinition } from '../domain/metadata';
import type {
  ConfidentialityView,
  DocumentConfiguration,
  DocumentTypePolicy,
} from '../application/configuration.port';

/**
 * Document's questions about configuration, answered by the modules that own it.
 *
 * Every call here goes through another module's **application service**. None of it reads
 * Administration's tables, Organisation's tables or Identity's, and that is the rule rather than a
 * preference: a repository in this module that selected from `document_type` would keep working
 * after Administration changed what a document type is, and would be wrong from that moment on with
 * nothing to say so.
 *
 * The assembly is here rather than in Administration for the mirror-image reason. "What does
 * creating a document need to know about a type" is Document's question, and answering it inside
 * Administration would put a document-shaped method on the module that configures types.
 */
@Injectable()
export class AdministrationConfigurationAdapter implements DocumentConfiguration {
  constructor(
    @Inject(CONFIGURATION_SERVICE) private readonly configuration: ConfigurationService,
    @Inject(ORGANIZATION_SERVICE) private readonly organization: OrganizationService,
    @Inject(USER_ADMIN_SERVICE) private readonly users: UserAdminService,
  ) {}

  /**
   * A document type with its fields fully described.
   *
   * The type's own row carries each field's key, name and data type; validating a *value* also
   * needs the field's options and its validation rules, which live on the field. So the fields are
   * fetched alongside — one call per distinct field on the type, which is a handful, and the
   * alternative is a document type row that carries everything anything might ever need.
   */
  async documentType(id: string): Promise<DocumentTypePolicy | null> {
    const type = await this.notFoundAsNull(() => this.configuration.getDocumentType(id));
    if (type === null) {
      return null;
    }

    const fields = await Promise.all(
      type.fields.map(async (field): Promise<FieldDefinition | null> => {
        const definition = await this.notFoundAsNull<MetadataFieldRow>(() =>
          this.configuration.getMetadataField(field.metadataFieldId),
        );
        if (definition === null) {
          // The type references a field that is gone. Administration refuses to delete a field a
          // live type uses, so this is not reachable by an ordinary path — and dropping the field
          // silently is still the wrong response, because a *required* field vanishing would turn
          // "this document is missing its reference number" into "this document is fine".
          return null;
        }
        return {
          id: definition.id,
          key: definition.key,
          name: definition.name,
          dataType: definition.dataType,
          isRequired: field.isRequired,
          // The option *values*. Administration stores a value and a label per option so a form
          // can render one and store the other; validating a value only ever compares the value,
          // and carrying the labels into the domain would put presentation in it.
          options: definition.options.map((option) => option.value),
          validation: {
            ...(definition.validation.minLength !== undefined && {
              minLength: definition.validation.minLength,
            }),
            ...(definition.validation.maxLength !== undefined && {
              maxLength: definition.validation.maxLength,
            }),
            // Named `minimum`/`maximum` by the configuration contract and `min`/`max` in the
            // domain. Translated here rather than renamed on either side: the contract's spelling
            // is shipped and the domain's reads better beside `minLength`.
            ...(definition.validation.minimum !== undefined && {
              min: definition.validation.minimum,
            }),
            ...(definition.validation.maximum !== undefined && {
              max: definition.validation.maximum,
            }),
            ...(definition.validation.pattern !== undefined && {
              pattern: definition.validation.pattern,
            }),
          },
        };
      }),
    );
    const resolved = fields.filter((field): field is FieldDefinition => field !== null);
    if (resolved.length !== type.fields.length) {
      throw new Error(`Document type ${id} references a metadata field that no longer exists.`);
    }

    return {
      id: type.id,
      name: type.name,
      isActive: type.isActive,
      defaultConfidentialityId: type.defaultConfidentialityId,
      retentionPolicyId: type.retentionPolicyId,
      revisionLabelStyle: type.revisionLabelStyle,
      // Ordered the way the type declares them, which is the order the form renders and the order
      // a person expects to tab through.
      fields: [...resolved].sort(
        (left, right) => sortOrderOf(type, left) - sortOrderOf(type, right),
      ),
    };
  }

  async confidentiality(id: string): Promise<ConfidentialityView | null> {
    const level = await this.notFoundAsNull(() => this.configuration.getConfidentiality(id));
    return level === null
      ? null
      : {
          id: level.id,
          name: level.name,
          rank: level.rank,
          allowDownload: level.allowDownload,
          allowPrint: level.allowPrint,
          requireReason: level.requireReason,
        };
  }

  async categoryExists(id: string): Promise<boolean> {
    return (await this.notFoundAsNull(() => this.configuration.getCategory(id))) !== null;
  }

  async userExists(id: string): Promise<boolean> {
    // Through Identity's own service, so a user in another tenant or a deleted one answers the
    // same way an unknown identifier does — which is what a metadata field naming a person needs.
    return (await this.notFoundAsNull(() => this.users.get(id))) !== null;
  }

  departmentExists(id: string): Promise<boolean> {
    return this.organization.exists(asId<AnyId>(id), ScopeType.DEPARTMENT);
  }

  /**
   * "Not found" as an answer rather than an exception.
   *
   * Administration's getters throw, correctly: they serve endpoints where a missing resource is a
   * 404. Here a missing type is a *validation failure on a field somebody chose*, which reads
   * completely differently — "that document type does not exist" beside the dropdown, not a blank
   * page. Converting once, here, is what lets the service say that.
   */
  private async notFoundAsNull<TResult>(read: () => Promise<TResult>): Promise<TResult | null> {
    try {
      return await read();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}

function sortOrderOf(
  type: { readonly fields: readonly { metadataFieldId: string; sortOrder: number }[] },
  field: FieldDefinition,
): number {
  return type.fields.find((entry) => entry.metadataFieldId === field.id)?.sortOrder ?? 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND'
  );
}
