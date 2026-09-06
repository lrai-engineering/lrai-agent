# Adding command labels

A GitHub label is only metadata until the receiver maps it to an operation and the worker knows how to perform that operation. `.lrai-agent.yml` currently has no custom-label registry.

## Where a new command belongs

| Layer | File | Change to consider |
| --- | --- | --- |
| Trigger recognition | `src/webhook.ts` | `LABEL_COMMANDS`, comment-command regex, opened/labeled decisions |
| Deploy combination | `src/webhook.ts` | `IMPLEMENT_COMMANDS`, `deployPreview`, `consumeLabels` |
| Command representation | `src/types.ts` | Queued command types |
| Execution routing | `src/worker.ts` | `providerAndCommand` or an explicit new execution path |
| Provider mode | `src/providers.ts`, `src/types.ts` | Only if introducing behavior beyond plan/implement |
| Prompt | `prompts/`, `src/task.ts`, `src/config.ts` | Only if a different prompt contract is needed |
| CLI | `src/index.ts` | Only if also exposing a local command |
| Tests | `test/webhook.test.ts`, `test/worker.test.ts`, provider/config tests | Recognition, authorization, routing, side effects |
| GitHub repository | Label settings | Create the exact label name |
| Installed host | Package and services | Deploy code and restart receiver/worker |

Creating a GitHub App event subscription for each label is unnecessary. Labels continue to arrive through the existing Issues subscription.

## Worked example: a planning alias

Suppose you want `codex-review` to mean “use the existing read-only Codex planning path.” This is an example to implement, not a currently supported label.

1. Add the recognized incoming label and comment spelling to the receiver.
2. Normalize it to the existing queued command `codex-plan`.
3. Preserve the original incoming label in `consumeLabels`, so the worker removes `codex-review`, not a label that was never applied.
4. Treat it as a provider command for ambiguity checks: `codex` plus `codex-review` must not silently pick one.
5. Keep `deployPreview` false for this planning alias.
6. Test both issue-opened and label-added events, plus the comment form.

The normalized decision should look like this:

```typescript
{
  command: "codex-plan",
  deployPreview: false,
  consumeLabels: ["codex-review"]
}
```

This alias reuses the current plan prompt. It does not introduce a dedicated PR-review prompt or load PR diffs. A true review feature needs a defined input contract and worker implementation.

Normalizing an alias means `providerAndCommand` can keep recognizing `codex-plan`. If you instead queue a new spelling unchanged, update that routing function too, or the worker will reject it.

## A genuinely new operation

For a command such as `review`, first define:

- Which issue/PR data it reads, and how the target PR is selected.
- Which provider and prompt it uses.
- Whether it can edit code, create commits, post review comments, or deploy.
- Which labels it consumes and how it behaves beside existing labels.
- What success/failure output the user receives.
- How duplicate events, partial failures, and retries are handled.

Then add a bounded dispatch path. A label must never become a shell command, executable path, arbitrary provider flag, deployment hostname, or sudo argument source.

The current `WebhookCommand` type is narrower than the actual accepted label spellings and recognition uses casts. When extending commands, make the type represent the actual normalized queue values; do not copy casts to conceal a missing dispatch case.

## Tests to add

| Scenario | Expected evidence |
| --- | --- |
| Recognized opened/labeled event | Correct normalized command and consumed labels |
| Newly created comment command | Correct dispatch; no label consumption |
| Unrelated/unknown label | Ignored |
| Unauthorized sender or bad signature | No queued execution |
| Conflicting provider labels | Defined non-ambiguous behavior |
| Planning alias with deploy | No accidental implementation/deployment |
| Worker execution | Correct provider/mode and result comment |
| Failure | Archived task and continued daemon operation |
| Permission-sensitive operation | No unintended branch, PR, shell, or deploy side effect |

Run `npm run check`. If local CLI behavior changed, exercise both plan and implement dry runs. Update this wiki's command table with the final semantics.

## Roll out the label

1. Commit/push the implementation and wait for its checks.
2. Install the complete built package on the host.
3. Restart both receiver and worker, so recognition and execution agree.
4. Create the label in the intended consuming repository.
5. Run a small authorized smoke test and inspect its result.

The narrow preview-worker patch updater does not deploy `src/webhook.ts`. Using it for a new label leaves the receiver on the old command set.

For repositories still using the Actions template, also update its trigger filters, job conditions, provider selection, and validation/publication path. App-worker code changes do not rewrite consuming Actions workflows.

Source: [receiver](https://github.com/lrai-engineering/lrai-agent/blob/main/src/webhook.ts), [worker routing](https://github.com/lrai-engineering/lrai-agent/blob/main/src/worker.ts), [types](https://github.com/lrai-engineering/lrai-agent/blob/main/src/types.ts).
