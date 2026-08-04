import { describe, expect, it } from 'vitest';

import { ApprovalTaskState, StageCompletionRule, TaskDecision } from '@edms/domain';

import {
  type CompletionRule,
  StageOutcome,
  type TaskState,
  actionableTasks,
  approvalsRequired,
  evaluateStage,
} from './completion';

/**
 * The one primitive that gives sequential, parallel and mixed routing.
 *
 * `07-workflow-architecture.md` §2 asks for exactly one mechanism rather than three code paths, so
 * these assertions are written as the three shapes a tenant would recognise — one approver in a
 * stage, several in a stage, several in an ordered stage — against the same function.
 */

const pending = (sequence = 0): TaskState => ({
  state: ApprovalTaskState.PENDING,
  decision: null,
  sequence,
});
const approved = (sequence = 0): TaskState => ({
  state: ApprovalTaskState.DECIDED,
  decision: TaskDecision.APPROVED,
  sequence,
});
const rejected = (sequence = 0): TaskState => ({
  state: ApprovalTaskState.DECIDED,
  decision: TaskDecision.REJECTED,
  sequence,
});
const changes = (sequence = 0): TaskState => ({
  state: ApprovalTaskState.DECIDED,
  decision: TaskDecision.CHANGES_REQUESTED,
  sequence,
});

const rule = (name: CompletionRule['rule'], threshold: number | null = null): CompletionRule => ({
  rule: name,
  threshold,
});

describe('approvalsRequired', () => {
  it('counts every task for ALL and one for ANY', () => {
    expect(approvalsRequired(rule(StageCompletionRule.ALL), 4)).toBe(4);
    expect(approvalsRequired(rule(StageCompletionRule.ANY), 4)).toBe(1);
  });

  it('rounds a percentage up', () => {
    // Rounding down would let a "50%" stage complete on nobody when there is one approver.
    expect(approvalsRequired(rule(StageCompletionRule.PERCENT, 50), 3)).toBe(2);
    expect(approvalsRequired(rule(StageCompletionRule.PERCENT, 50), 2)).toBe(1);
    expect(approvalsRequired(rule(StageCompletionRule.PERCENT, 1), 1)).toBe(1);
  });

  it('caps a quorum at the number of people who are actually there', () => {
    // Publish refuses a quorum larger than the *resolvers*, but a resolver yields fewer people than
    // it names the day one of them leaves. Capping makes that stage completable by everybody
    // remaining rather than permanently unreachable.
    expect(approvalsRequired(rule(StageCompletionRule.QUORUM, 3), 2)).toBe(2);
  });
});

describe('evaluateStage', () => {
  it('completes a sequential stage on its single approval', () => {
    expect(evaluateStage(rule(StageCompletionRule.ALL), [approved()])).toBe(StageOutcome.APPROVED);
  });

  it('waits for every approver under ALL', () => {
    expect(evaluateStage(rule(StageCompletionRule.ALL), [approved(), pending()])).toBe(
      StageOutcome.PENDING,
    );
    expect(evaluateStage(rule(StageCompletionRule.ALL), [approved(), approved()])).toBe(
      StageOutcome.APPROVED,
    );
  });

  it('completes on the first approval under ANY', () => {
    expect(evaluateStage(rule(StageCompletionRule.ANY), [approved(), pending(), pending()])).toBe(
      StageOutcome.APPROVED,
    );
  });

  it('counts a quorum', () => {
    const quorum = rule(StageCompletionRule.QUORUM, 2);
    expect(evaluateStage(quorum, [approved(), pending(), pending()])).toBe(StageOutcome.PENDING);
    expect(evaluateStage(quorum, [approved(), approved(), pending()])).toBe(StageOutcome.APPROVED);
  });

  it('lets a rejection end the stage however many approvals it already had', () => {
    // An approval is one control being satisfied, not a vote that outweighs a refusal. A rejection
    // is checked before the count for that reason, and the count never gets to overrule it.
    expect(evaluateStage(rule(StageCompletionRule.ALL), [approved(), rejected()])).toBe(
      StageOutcome.REJECTED,
    );
    expect(
      evaluateStage(rule(StageCompletionRule.QUORUM, 2), [approved(), approved(), rejected()]),
    ).toBe(StageOutcome.REJECTED);

    // In a running instance that last state does not arise: the stage completes on the second
    // approval and the third task is superseded before anybody can decide it. The rule is stated
    // here anyway, because a pure function evaluated on a snapshot must not depend on the caller
    // having already done the right thing.
  });

  it('reports a quorum that can no longer be reached as unreachable, not as a rejection', () => {
    // Four approvers, a quorum of three, two of whom asked for changes. Nobody rejected it. Calling
    // this a rejection would attribute a decision to somebody who did not make one, and the audit
    // trail would then name the wrong person.
    const outcome = evaluateStage(rule(StageCompletionRule.QUORUM, 3), [
      approved(),
      changes(),
      changes(),
      pending(),
    ]);
    expect(outcome).toBe(StageOutcome.CHANGES_REQUESTED);

    // With no request for changes in play — two tasks withdrawn because their assignees left — the
    // same shortfall is reported for what it is.
    const withdrawn: TaskState = {
      state: ApprovalTaskState.WITHDRAWN,
      decision: null,
      sequence: 0,
    };
    expect(
      evaluateStage(rule(StageCompletionRule.QUORUM, 3), [approved(), withdrawn, withdrawn]),
    ).toBe(StageOutcome.UNREACHABLE);
  });

  it('never reports an empty stage as approved', () => {
    // A resolver yielding nobody fails submission loudly (§8). This function is not the place that
    // quietly makes an empty control pass, even though it should never be handed one.
    expect(evaluateStage(rule(StageCompletionRule.ALL), [])).toBe(StageOutcome.PENDING);
  });
});

describe('actionableTasks', () => {
  it('offers every pending task in a parallel stage', () => {
    const tasks = [pending(), pending(), approved()];
    expect(actionableTasks(false, tasks)).toHaveLength(2);
  });

  it('offers only the earliest outstanding step in an ordered stage', () => {
    const tasks = [pending(0), pending(1), pending(2)];
    expect(actionableTasks(true, tasks)).toEqual([tasks[0]]);
  });

  it('moves an ordered stage on as each step is decided', () => {
    const tasks = [approved(0), pending(1), pending(2)];
    expect(actionableTasks(true, tasks)).toEqual([tasks[1]]);
  });

  it('offers every task sharing the earliest step', () => {
    // Two resolvers can legitimately place two people at one step. Picking one of them arbitrarily
    // would make the routing depend on insertion order.
    const tasks = [pending(0), pending(0), pending(1)];
    expect(actionableTasks(true, tasks)).toHaveLength(2);
  });
});
