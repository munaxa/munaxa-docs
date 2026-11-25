import { describe, expect, it } from 'vitest';

import {
  createApprovalGroupSchema,
  createCategorySchema,
  createConfidentialityLevelSchema,
  createDepartmentSchema,
  createDocumentTypeSchema,
  createLibrarySchema,
  createMetadataFieldSchema,
  createNumberingRuleSchema,
  createRetentionPolicySchema,
  createWorkflowDefinitionSchema,
} from '@edms/contracts';

import { checkRule } from '../modules/administration/domain/numbering';
import { checkVersion } from '../modules/workflow/domain/version-validator';
import {
  STARTER_APPROVAL_GROUP,
  STARTER_CATEGORIES,
  STARTER_CONFIDENTIALITY,
  STARTER_DEPARTMENTS,
  STARTER_DOCUMENT_TYPES,
  STARTER_LIBRARIES,
  STARTER_METADATA_FIELDS,
  STARTER_NUMBERING_RULES,
  STARTER_RETENTION,
  STARTER_WORKFLOW,
} from './starter-catalogue';

/**
 * The catalogue is accepted by the same schemas and domain checks the administration screens use.
 *
 * Run without a database: a catalogue entry the product would refuse is found here, at build
 * time, rather than as a half-loaded tenant in Testing.
 */

const AN_ID = '0190a5b2-7c4d-7e8f-9a0b-1c2d3e4f5a6b';

function unique(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toUpperCase())).size === values.length;
}

describe('the starter catalogue', () => {
  it('passes every create schema the HTTP API applies', () => {
    for (const department of STARTER_DEPARTMENTS) {
      expect(() => createDepartmentSchema.parse({ entityId: AN_ID, ...department })).not.toThrow();
    }
    for (const level of STARTER_CONFIDENTIALITY) {
      expect(() => createConfidentialityLevelSchema.parse(level)).not.toThrow();
    }
    for (const policy of STARTER_RETENTION) {
      expect(() => createRetentionPolicySchema.parse(policy)).not.toThrow();
    }
    for (const category of STARTER_CATEGORIES) {
      expect(() =>
        createCategorySchema.parse({
          parentId: category.parent === null ? null : AN_ID,
          code: category.code,
          name: category.name,
        }),
      ).not.toThrow();
    }
    for (const field of STARTER_METADATA_FIELDS) {
      expect(() => createMetadataFieldSchema.parse(field)).not.toThrow();
    }
    for (const rule of STARTER_NUMBERING_RULES) {
      expect(() => createNumberingRuleSchema.parse(rule)).not.toThrow();
    }
    expect(() =>
      createApprovalGroupSchema.parse({ ...STARTER_APPROVAL_GROUP, memberIds: [AN_ID] }),
    ).not.toThrow();
    expect(() => createWorkflowDefinitionSchema.parse(STARTER_WORKFLOW)).not.toThrow();
    for (const type of STARTER_DOCUMENT_TYPES) {
      expect(() =>
        createDocumentTypeSchema.parse({
          code: type.code,
          name: type.name,
          description: type.description,
          numberingRuleId: AN_ID,
          workflowDefinitionId: type.workflow === null ? null : AN_ID,
          retentionPolicyId: type.retention === null ? null : AN_ID,
          defaultConfidentialityId: AN_ID,
          revisionLabelStyle: type.revisionLabelStyle,
          fields: type.fields.map((field, index) => ({
            metadataFieldId: AN_ID,
            isRequired: field.isRequired,
            sortOrder: index,
          })),
        }),
      ).not.toThrow();
    }
    for (const library of STARTER_LIBRARIES) {
      expect(() =>
        createLibrarySchema.parse({
          code: library.code,
          name: library.name,
          description: library.description,
          ownerScopeType: library.department === null ? 'TENANT' : 'DEPARTMENT',
          ownerScopeId: library.department === null ? null : AN_ID,
        }),
      ).not.toThrow();
    }
  });

  it('holds numbering rules the numbering engine accepts', () => {
    for (const rule of STARTER_NUMBERING_RULES) {
      expect(checkRule(createNumberingRuleSchema.parse(rule))).toEqual([]);
    }
  });

  it('holds a workflow that can be published', () => {
    const parsed = createWorkflowDefinitionSchema.parse(STARTER_WORKFLOW);
    expect(checkVersion(parsed.definition)).toEqual([]);
  });

  it('has no duplicate codes, keys or confidentiality ranks', () => {
    expect(unique(STARTER_DEPARTMENTS.map((entry) => entry.code))).toBe(true);
    expect(unique(STARTER_CONFIDENTIALITY.map((entry) => entry.code))).toBe(true);
    expect(new Set(STARTER_CONFIDENTIALITY.map((entry) => entry.rank)).size).toBe(
      STARTER_CONFIDENTIALITY.length,
    );
    expect(unique(STARTER_RETENTION.map((entry) => entry.code))).toBe(true);
    expect(unique(STARTER_CATEGORIES.map((entry) => entry.code))).toBe(true);
    expect(unique(STARTER_METADATA_FIELDS.map((entry) => entry.key))).toBe(true);
    expect(unique(STARTER_NUMBERING_RULES.map((entry) => entry.key))).toBe(true);
    expect(unique(STARTER_DOCUMENT_TYPES.map((entry) => entry.code))).toBe(true);
    expect(unique(STARTER_LIBRARIES.map((entry) => entry.code))).toBe(true);
  });

  it('only refers to entries it defines, parents before children', () => {
    const departments = new Set<string>(STARTER_DEPARTMENTS.map((entry) => entry.code));
    const levels = new Set<string>(STARTER_CONFIDENTIALITY.map((entry) => entry.code));
    const policies = new Set<string>(STARTER_RETENTION.map((entry) => entry.code));
    const fields = new Set<string>(STARTER_METADATA_FIELDS.map((entry) => entry.key));
    const rules = new Set<string>(STARTER_NUMBERING_RULES.map((entry) => entry.key));

    const seen = new Set<string>();
    for (const category of STARTER_CATEGORIES) {
      if (category.parent !== null) {
        expect(seen.has(category.parent)).toBe(true);
      }
      seen.add(category.code);
    }
    for (const type of STARTER_DOCUMENT_TYPES) {
      expect(rules.has(type.numberingRule)).toBe(true);
      expect(levels.has(type.confidentiality)).toBe(true);
      if (type.retention !== null) {
        expect(policies.has(type.retention)).toBe(true);
      }
      if (type.workflow !== null) {
        expect(type.workflow).toBe(STARTER_WORKFLOW.key);
      }
      for (const field of type.fields) {
        expect(fields.has(field.key)).toBe(true);
      }
    }
    for (const library of STARTER_LIBRARIES) {
      if (library.department !== null) {
        expect(departments.has(library.department)).toBe(true);
      }
    }
    for (const stage of STARTER_WORKFLOW.definition.stages) {
      for (const participant of stage.participants) {
        expect(participant.groupKey).toBe(STARTER_APPROVAL_GROUP.key);
      }
    }
  });
});
