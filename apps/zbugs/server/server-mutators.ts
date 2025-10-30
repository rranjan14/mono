import {type ServerTransaction, type UpdateValue} from '@rocicorp/zero';
import type {PostgresJsTransaction} from '@rocicorp/zero/server/adapters/postgresjs';
import {type AuthData} from '../shared/auth.ts';
import {
  createMutators,
  type AddCommentArgs,
  type AddEmojiArgs,
  type CreateIssueArgs,
} from '../shared/mutators.ts';
import {schema, type Schema} from '../shared/schema.ts';
import {notify} from './notify.ts';
import {MutationErrorCode} from '../shared/error.ts';
import {MutationError} from '../shared/error.ts';

export type PostCommitTask = () => Promise<void>;
type MutatorTx = ServerTransaction<Schema, PostgresJsTransaction>;

export function createServerMutators(
  authData: AuthData | undefined,
  postCommitTasks: PostCommitTask[],
) {
  const mutators = createMutators(authData);

  return {
    ...mutators,

    issue: {
      ...mutators.issue,

      async create(
        tx: MutatorTx,
        {id, projectID, title, description}: CreateIssueArgs,
      ) {
        await mutators.issue.create(tx, {
          id,
          projectID,
          title,
          description,
          created: Date.now(),
          modified: Date.now(),
        });

        await notify(
          tx,
          authData,
          {kind: 'create-issue', issueID: id},
          postCommitTasks,
        );
      },

      async update(
        tx: MutatorTx,
        args: {id: string} & UpdateValue<typeof schema.tables.issue>,
      ) {
        await mutators.issue.update(tx, {
          ...args,
          modified: Date.now(),
        });

        await notify(
          tx,
          authData,
          {
            kind: 'update-issue',
            issueID: args.id,
            update: args,
          },
          postCommitTasks,
        );
      },

      async addLabel(
        tx: MutatorTx,
        {issueID, labelID}: {issueID: string; labelID: string},
      ) {
        await mutators.issue.addLabel(tx, {issueID, labelID});

        await notify(
          tx,
          authData,
          {
            kind: 'update-issue',
            issueID,
            update: {id: issueID},
          },
          postCommitTasks,
        );
      },

      async removeLabel(
        tx: MutatorTx,
        {issueID, labelID}: {issueID: string; labelID: string},
      ) {
        await mutators.issue.removeLabel(tx, {issueID, labelID});

        await notify(
          tx,
          authData,
          {
            kind: 'update-issue',
            issueID,
            update: {id: issueID},
          },
          postCommitTasks,
        );
      },
    },

    emoji: {
      ...mutators.emoji,

      async addToIssue(tx: MutatorTx, args: AddEmojiArgs) {
        await mutators.emoji.addToIssue(tx, {
          ...args,
          created: Date.now(),
        });

        await notify(
          tx,
          authData,
          {
            kind: 'add-emoji-to-issue',
            issueID: args.subjectID,
            emoji: args.unicode,
          },
          postCommitTasks,
        );
      },

      async addToComment(tx: MutatorTx, args: AddEmojiArgs) {
        await mutators.emoji.addToComment(tx, {
          ...args,
          created: Date.now(),
        });

        const comment = await tx.query.comment
          .where('id', args.subjectID)
          .one()
          .run();

        if (!comment) {
          throw new MutationError(
            `Comment not found`,
            MutationErrorCode.NOTIFICATION_FAILED,
            args.subjectID,
          );
        }

        await notify(
          tx,
          authData,
          {
            kind: 'add-emoji-to-comment',
            issueID: comment.issueID,
            commentID: args.subjectID,
            emoji: args.unicode,
          },
          postCommitTasks,
        );
      },
    },

    comment: {
      ...mutators.comment,

      async add(tx: MutatorTx, {id, issueID, body}: AddCommentArgs) {
        await mutators.comment.add(tx, {
          id,
          issueID,
          body,
          created: Date.now(),
        });

        await notify(
          tx,
          authData,
          {
            kind: 'add-comment',
            issueID,
            commentID: id,
            comment: body,
          },
          postCommitTasks,
        );
      },

      async edit(tx: MutatorTx, {id, body}: {id: string; body: string}) {
        await mutators.comment.edit(tx, {id, body});

        const comment = await tx.query.comment.where('id', id).one().run();

        if (!comment) {
          throw new MutationError(
            `Comment not found`,
            MutationErrorCode.NOTIFICATION_FAILED,
            id,
          );
        }

        await notify(
          tx,
          authData,
          {
            kind: 'edit-comment',
            issueID: comment.issueID,
            commentID: id,
            comment: body,
          },
          postCommitTasks,
        );
      },
    },
  } as const;
}
