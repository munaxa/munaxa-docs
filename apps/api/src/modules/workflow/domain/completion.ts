import {
  ApprovalTaskState,
  type ApprovalTaskStateKey,
  StageCompletionRule,
  type StageCompletionRuleKey,
  TaskDecision,
  type TaskDecisionKey,
} from '@edms/domain';

/**
 * Whether a stage is finished, and what finished it.
 *
 * This is the file `07-workflow-architecture.md` §2 is describing when it says one primitive gives
 * sequential, parallel and mixed routing "rather than three code paths". Stages run in order; tasks
 * inside a stage run in parallel unless the stage is `ordered`; and how many of them must agree is
 * `ALL`, `ANY`, `QUORUM(n)` or `PERCENT(p)`. Sequential approval is one task per stage. Parallel
 * approval is several tasks in one stage. Mixed is both, and there is nothing in the engine that
 * knows which of the three a definition happens to be — which is the property that makes a fourth
 * routing shape a definition rather than a release.
 *
 * Pure, and it takes the tasks as values. Counting a quorum is arithmetic, and arithmetic that can
 * see a database is arithmetic that can be wrong about which rows it counted.
 */

/** One task, reduced to what the rule needs. */
export interface TaskState {
  readonly state: ApprovalTaskStateKey;
  readonly decision: TaskDecisionKey | null;
  /** Position in an `ordered` stage. Zero everywhere in a parallel one. */
  readonly sequence: number;
}

export const StageOutcome = {
  /** Not finished. More decisions are wanted, and the pending tasks stay pending. */
  PENDING: 'PENDING',
  /** Enough approvals. The stage completes and the instance moves on. */
  APPROVED: 'APPROVED',
  /** Somebody rejected. What that does to the instance is the definition's `onReject`. */
  REJECTED: 'REJECTED',
  /** Somebody asked for changes. The document goes back to its author. */
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  /**
   * Enough tasks were decided that the required number of approvals can no longer be reached.
   *
   * Its own outcome rather than a rejection, and the distinction is not pedantic. A three-person
   * quorum with four approvers, two of whom asked for changes, has not been *rejected* by anybody —
   * it has become unreachable. Reporting it as a rejection would attribute a decision to somebody
   * who did not make one, and the audit trail would name the wrong person.
   */
  UNREACHABLE: 'UNREACHABLE',
} as const;

export type StageOutcomeKey = (typeof StageOutcome)[keyof typeof StageOutcome];

export interface CompletionRule {
  readonly rule: StageCompletionRuleKey;
  /** The count for `QUORUM`, the percentage for `PERCENT`. Null for `ALL` and `ANY`. */
  readonly threshold: number | null;
}

/**
 * How many approvals this stage needs, out of how many tasks it has.
 *
 * Exposed rather than kept private because it is what a screen shows — "2 of 3 approvals" — and a
 * client computing it from the rule would be a second implementation of `PERCENT`'s rounding.
 */
export function approvalsRequired(rule: CompletionRule, taskCount: number): number {
  switch (rule.rule) {
    case StageCompletionRule.ALL:
      return taskCount;
    case StageCompletionRule.ANY:
      return Math.min(1, taskCount);
    case StageCompletionRule.QUORUM:
      // Capped at the task count. A quorum larger than the number of approvers is refused at
      // publish against the *resolvers*, but a resolver can yield fewer people than it names —
      // a role with three holders, one of whom has left. Capping makes that stage completable by
      // everybody who is actually there rather than permanently unreachable.
      return Math.min(rule.threshold ?? taskCount, taskCount);
    case StageCompletionRule.PERCENT:
      // Rounded up, as §2 says. Half of two approvers is one; half of three is two. Rounding down
      // would let a "50%" stage complete on nobody when there is one approver.
      return Math.min(Math.ceil((taskCount * (rule.threshold ?? 100)) / 100), taskCount);
    default:
      return taskCount;
  }
}

/**
 * The stage's outcome, given everything decided so far.
 *
 * The order of the checks is the order the rules apply in, and it matters. A rejection ends the
 * stage however many approvals it already had — an approval is not a vote that outweighs a refusal,
 * it is one control being satisfied — and §2's `onReject` decides what that does to the instance.
 */
export function evaluateStage(rule: CompletionRule, tasks: readonly TaskState[]): StageOutcomeKey {
  if (tasks.length === 0) {
    // A stage with no tasks never reaches here: a resolver yielding nobody fails submission loudly
    // rather than skipping the stage (§8). Returning `PENDING` rather than `APPROVED` keeps this
    // function from being the place that quietly makes an empty control pass, if it ever did.
    return StageOutcome.PENDING;
  }

  const decided = tasks.filter((task) => task.decision !== null);
  const rejected = decided.find((task) => task.decision === TaskDecision.REJECTED);
  if (rejected !== undefined) {
    return StageOutcome.REJECTED;
  }
  const changes = decided.find((task) => task.decision === TaskDecision.CHANGES_REQUESTED);
  if (changes !== undefined) {
    return StageOutcome.CHANGES_REQUESTED;
  }

  const approved = decided.filter((task) => task.decision === TaskDecision.APPROVED).length;
  const required = approvalsRequired(rule, tasks.length);
  if (approved >= required) {
    return StageOutcome.APPROVED;
  }

  // Tasks that can still be approved. A withdrawn or superseded task is neither an approval nor a
  // refusal, and counting it as available would leave a stage pending on decisions nobody can make.
  const available = tasks.filter(
    (task) => task.decision === null && task.state === ApprovalTaskState.PENDING,
  ).length;
  return approved + available < required ? StageOutcome.UNREACHABLE : StageOutcome.PENDING;
}

/**
 * Which tasks may be decided right now.
 *
 * In a parallel stage, every pending one. In an `ordered` stage, only the earliest — which is what
 * makes sequential approval *within* a stage a property of the same primitive rather than a second
 * mechanism. An approver later in the sequence is deliberately given a task that exists and is not
 * yet actionable, so the whole routing is visible from the moment the stage activates rather than
 * appearing one person at a time.
 */
export function actionableTasks<TTask extends TaskState>(
  ordered: boolean,
  tasks: readonly TTask[],
): readonly TTask[] {
  const pending = tasks.filter(
    (task) => task.decision === null && task.state === ApprovalTaskState.PENDING,
  );
  if (!ordered || pending.length === 0) {
    return pending;
  }
  const first = Math.min(...pending.map((task) => task.sequence));
  // Every task at the lowest outstanding position, not merely one: two resolvers can legitimately
  // place two people at the same step of a sequence, and picking one of them arbitrarily would make
  // the routing depend on insertion order.
  return pending.filter((task) => task.sequence === first);
}
