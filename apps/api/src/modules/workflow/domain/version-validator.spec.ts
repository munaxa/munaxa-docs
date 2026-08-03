import { describe, expect, it } from 'vitest';

import {
  DeadlineCalendar,
  ManagerOfSubject,
  ParticipantKind,
  StageCompletionRule,
} from '@edms/domain';

import {
  type DefinitionShape,
  type StageShape,
  checkVersion,
  isEvaluableConditionField,
} from './version-validator';

/**
 * What a version must satisfy to become the rules an approval runs by.
 *
 * Every case here is one that would otherwise fail at *submission* — in front of an author who cannot
 * fix it — rather than at publish, in front of the person who wrote the definition.
 */

function stageFor(overrides: Partial<StageShape> = {}): StageShape {
  return {
    name: 'Department review',
    participants: [{ kind: ParticipantKind.MANAGER_OF, of: ManagerOfSubject.AUTHOR }],
    completionRule: StageCompletionRule.ALL,
    ordered: false,
    condition: null,
    deadline: null,
    reminders: [],
    onOverdue: { action: 'NOTIFY_ONLY' },
    maxEscalations: 2,
    ...overrides,
  };
}

function definitionFor(stages: readonly StageShape[]): DefinitionShape {
  return { stages, appliesTo: { documentTypes: [] } };
}

describe('a publishable version', () => {
  it('accepts the shape the architecture gives as its example', () => {
    // Two stages, a manager resolver, a quorum, a deadline and an escalation — §2's worked example.
    const definition = definitionFor([
      stageFor({
        deadline: { duration: 'P3D', calendar: DeadlineCalendar.WORKING_DAYS } as never,
        reminders: [{ before: 'P1D' }],
        onOverdue: { action: 'ESCALATE' },
      }),
      stageFor({
        name: 'Quality approval',
        participants: [
          { kind: ParticipantKind.ROLE, roleKey: 'quality-manager' },
          { kind: ParticipantKind.ROLE, roleKey: 'compliance' },
        ],
        completionRule: StageCompletionRule.QUORUM,
        threshold: 2,
        condition: { field: 'confidentiality.rank', op: '>=' },
        deadline: { duration: 'P5D', calendar: DeadlineCalendar.WORKING_DAYS } as never,
      }),
    ]);

    expect(checkVersion(definition)).toEqual([]);
  });

  it('refuses a version with no stages, without piling on', () => {
    expect(checkVersion(definitionFor([]))).toEqual(['NO_STAGES']);
  });

  it('refuses a stage nobody is asked to approve', () => {
    // It would fail at submission with a named reason — but that is the wrong moment and the wrong
    // person.
    expect(checkVersion(definitionFor([stageFor({ participants: [] })]))).toContain(
      'STAGE_WITHOUT_PARTICIPANTS',
    );
  });

  it('refuses two stages with one name', () => {
    // Stages are named in notifications, task lists and audit events. Two with one name makes every one
    // of those ambiguous.
    expect(
      checkVersion(definitionFor([stageFor(), stageFor({ name: 'DEPARTMENT REVIEW' })])),
    ).toContain('DUPLICATE_STAGE_NAME');
  });

  it('reports a named person as a problem worth acknowledging', () => {
    // Permitted by §2 and called discouraged there, because the definition breaks the day they leave.
    expect(
      checkVersion(
        definitionFor([
          stageFor({
            participants: [
              { kind: ParticipantKind.USER, userId: '00000000-0000-0000-0000-000000000001' },
            ],
          }),
        ]),
      ),
    ).toContain('NAMED_USER_PARTICIPANT');
  });
});

describe('completion rules', () => {
  it('demands a threshold for a quorum and refuses one elsewhere', () => {
    expect(
      checkVersion(definitionFor([stageFor({ completionRule: StageCompletionRule.QUORUM })])),
    ).toContain('THRESHOLD_MISSING');

    expect(
      checkVersion(
        definitionFor([stageFor({ completionRule: StageCompletionRule.ALL, threshold: 2 })]),
      ),
    ).toContain('THRESHOLD_NOT_APPLICABLE');
  });

  it('refuses a quorum larger than the number of resolvers', () => {
    // A stage that can never complete. Caught here rather than at the submission it would block.
    expect(
      checkVersion(
        definitionFor([
          stageFor({
            participants: [{ kind: ParticipantKind.ROLE, roleKey: 'approver' }],
            completionRule: StageCompletionRule.QUORUM,
            threshold: 3,
          }),
        ]),
      ),
    ).toContain('QUORUM_EXCEEDS_PARTICIPANTS');
  });

  it('bounds a percentage to a percentage', () => {
    expect(
      checkVersion(
        definitionFor([stageFor({ completionRule: StageCompletionRule.PERCENT, threshold: 101 })]),
      ),
    ).toContain('PERCENT_OUT_OF_RANGE');
  });
});

describe('deadlines and escalation', () => {
  it('refuses a reminder with nothing to measure it against', () => {
    expect(checkVersion(definitionFor([stageFor({ reminders: [{ before: 'P1D' }] })]))).toContain(
      'REMINDER_WITHOUT_DEADLINE',
    );
  });

  it('refuses an overdue behaviour on a stage that can never be overdue', () => {
    expect(
      checkVersion(definitionFor([stageFor({ onOverdue: { action: 'TERMINATE' } })])),
    ).toContain('OVERDUE_WITHOUT_DEADLINE');
  });

  it('refuses automatic approval unless the stage is declared to decide nothing', () => {
    // An approval nobody made is a control that is not there. §5 permits it only where the author has
    // consciously said the stage is informational.
    expect(
      checkVersion(
        definitionFor([
          stageFor({
            deadline: { duration: 'P1D', calendar: DeadlineCalendar.CALENDAR_DAYS } as never,
            onOverdue: { action: 'AUTO_APPROVE' },
          }),
        ]),
      ),
    ).toContain('AUTO_APPROVE_NOT_DECLARED');

    expect(
      checkVersion(
        definitionFor([
          stageFor({
            deadline: { duration: 'P1D', calendar: DeadlineCalendar.CALENDAR_DAYS } as never,
            onOverdue: { action: 'AUTO_APPROVE', nonControlling: true },
          }),
        ]),
      ),
    ).toEqual([]);
  });
});

describe('conditions', () => {
  it('accepts the facts the evaluator can resolve', () => {
    expect(isEvaluableConditionField('confidentiality.rank')).toBe(true);
    expect(isEvaluableConditionField('revision.isFirst')).toBe(true);
    // Metadata keys are tenant data and cannot be enumerated here, so they are matched by prefix.
    expect(isEvaluableConditionField('metadata.market')).toBe(true);
  });

  it('refuses a fact it cannot', () => {
    expect(isEvaluableConditionField('document.secretHandshake')).toBe(false);
  });

  it('treats a stage gated on an unresolvable fact as unreachable', () => {
    // It would never be true, because it would never be evaluated — which is the definition of an
    // unreachable stage, and §7 forbids one.
    expect(
      checkVersion(
        definitionFor([stageFor({ condition: { field: 'document.invented', op: '=' } })]),
      ),
    ).toContain('UNREACHABLE_STAGE');
  });
});

describe('reporting', () => {
  it('reports every reason, not the first', () => {
    // A definition is built once, carefully, at the end of an implementation project. Discovering its
    // problems one save at a time is the experience this avoids.
    const rejections = checkVersion(
      definitionFor([
        stageFor({
          name: '  ',
          participants: [],
          completionRule: StageCompletionRule.QUORUM,
          reminders: [{ before: 'P1D' }],
        }),
      ]),
    );

    expect(new Set(rejections)).toEqual(
      new Set([
        'STAGE_WITHOUT_NAME',
        'STAGE_WITHOUT_PARTICIPANTS',
        'THRESHOLD_MISSING',
        'REMINDER_WITHOUT_DEADLINE',
      ]),
    );
  });
});
