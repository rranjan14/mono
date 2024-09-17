import {describe, expect, test} from 'vitest';
import {newQuery, QueryDelegate} from './query-impl.js';
import {issueSchema} from './test/testSchemas.js';
import {QueryDelegateImpl} from './query-impl.query.test.js';

function addData(queryDelegate: QueryDelegate) {
  queryDelegate
    .getSource('user')
    .push({type: 'add', row: {id: '001', name: 'Alice'}});
  queryDelegate
    .getSource('user')
    .push({type: 'add', row: {id: '002', name: 'Bob'}});
  queryDelegate
    .getSource('user')
    .push({type: 'add', row: {id: '003', name: 'Charlie'}});
  queryDelegate
    .getSource('user')
    .push({type: 'add', row: {id: '004', name: 'Daniel'}});

  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '101',
      title: 'Issue 1',
      description: 'Description 1',
      closed: false,
      ownerId: '001',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '102',
      title: 'Issue 2',
      description: 'Description 2',
      closed: false,
      ownerId: '001',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '103',
      title: 'Issue 3',
      description: 'Description 3',
      closed: false,
      ownerId: '001',
    },
  });

  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '104',
      title: 'Issue 4',
      description: 'Description 4',
      closed: false,
      ownerId: '002',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '105',
      title: 'Issue 5',
      description: 'Description 5',
      closed: false,
      ownerId: '002',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '106',
      title: 'Issue 6',
      description: 'Description 6',
      closed: true,
      ownerId: '002',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '107',
      title: 'Issue 7',
      description: 'Description 7',
      closed: true,
      ownerId: '003',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '108',
      title: 'Issue 8',
      description: 'Description 8',
      closed: true,
      ownerId: '003',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '109',
      title: 'Issue 9',
      description: 'Description 9',
      closed: false,
      ownerId: '003',
    },
  });
  queryDelegate.getSource('issue').push({
    type: 'add',
    row: {
      id: '110',
      title: 'Issue 10',
      description: 'Description 10',
      closed: false,
      ownerId: '004',
    },
  });

  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '201',
      issueId: '101',
      text: 'Comment 1',
      authorId: '001',
      createdAt: 1,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '202',
      issueId: '101',
      text: 'Comment 2',
      authorId: '002',
      createdAt: 2,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '203',
      issueId: '101',
      text: 'Comment 3',
      authorId: '003',
      createdAt: 3,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '204',
      issueId: '102',
      text: 'Comment 4',
      authorId: '001',
      createdAt: 4,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '205',
      issueId: '102',
      text: 'Comment 5',
      authorId: '002',
      createdAt: 5,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '206',
      issueId: '102',
      text: 'Comment 6',
      authorId: '003',
      createdAt: 6,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '207',
      issueId: '103',
      text: 'Comment 7',
      authorId: '001',
      createdAt: 7,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '208',
      issueId: '103',
      text: 'Comment 8',
      authorId: '002',
      createdAt: 8,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '209',
      issueId: '103',
      text: 'Comment 9',
      authorId: '003',
      createdAt: 9,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '210',
      issueId: '105',
      text: 'Comment 10',
      authorId: '001',
      createdAt: 10,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '211',
      issueId: '105',
      text: 'Comment 11',
      authorId: '002',
      createdAt: 11,
    },
  });
  queryDelegate.getSource('comment').push({
    type: 'add',
    row: {
      id: '212',
      issueId: '105',
      text: 'Comment 12',
      authorId: '003',
      createdAt: 12,
    },
  });

  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '301', commentId: '209', text: 'Revision 1', authorId: '001'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '302', commentId: '209', text: 'Revision 2', authorId: '001'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '303', commentId: '209', text: 'Revision 3', authorId: '001'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '304', commentId: '208', text: 'Revision 1', authorId: '002'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '305', commentId: '208', text: 'Revision 2', authorId: '002'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '306', commentId: '208', text: 'Revision 3', authorId: '002'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '307', commentId: '211', text: 'Revision 1', authorId: '003'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '308', commentId: '211', text: 'Revision 2', authorId: '003'},
  });
  queryDelegate.getSource('revision').push({
    type: 'add',
    row: {id: '309', commentId: '211', text: 'Revision 3', authorId: '003'},
  });

  queryDelegate
    .getSource('label')
    .push({type: 'add', row: {id: '401', name: 'bug'}});
  queryDelegate
    .getSource('label')
    .push({type: 'add', row: {id: '402', name: 'feature'}});

  queryDelegate
    .getSource('issueLabel')
    .push({type: 'add', row: {issueId: '103', labelId: '401'}});
  queryDelegate
    .getSource('issueLabel')
    .push({type: 'add', row: {issueId: '102', labelId: '401'}});
  queryDelegate
    .getSource('issueLabel')
    .push({type: 'add', row: {issueId: '102', labelId: '402'}});
}

describe('kitchen sink query', () => {
  test('complex query with filters, limits, and multiple joins', () => {
    const queryDelegate = new QueryDelegateImpl();
    addData(queryDelegate);
    const issueQuery = newQuery(queryDelegate, issueSchema)
      .where('ownerId', 'IN', ['001', '002', '003'])
      .where('closed', false)
      .related('owner', q => q.select('name'))
      .related('comments', q =>
        q
          .select('text')
          .orderBy('createdAt', 'desc')
          .related('revisions', q => q.orderBy('id', 'desc').limit(1))
          .limit(2),
      )
      .related('labels', q => q.select('name'))
      .start({
        id: '101',
        title: 'Issue 1',
        description: 'Description 1',
        closed: false,
        ownerId: '001',
      })
      .orderBy('title', 'asc')
      .limit(6);

    const view = issueQuery.materialize();
    view.hydrate();

    expect(queryDelegate.addedServerQueries).toEqual([
      {
        limit: 6,
        orderBy: [
          ['title', 'asc'],
          ['id', 'asc'],
        ],
        related: [
          {
            correlation: {
              childField: 'id',
              op: '=',
              parentField: 'ownerId',
            },
            subquery: {
              alias: 'owner',
              orderBy: [['id', 'asc']],
              table: 'user',
            },
          },
          {
            correlation: {
              childField: 'issueId',
              op: '=',
              parentField: 'id',
            },
            subquery: {
              alias: 'comments',
              limit: 2,
              orderBy: [
                ['createdAt', 'desc'],
                ['id', 'asc'],
              ],
              related: [
                {
                  correlation: {
                    childField: 'commentId',
                    op: '=',
                    parentField: 'id',
                  },
                  subquery: {
                    alias: 'revisions',
                    limit: 1,
                    orderBy: [['id', 'desc']],
                    table: 'revision',
                  },
                },
              ],
              table: 'comment',
            },
          },
          {
            correlation: {
              childField: 'issueId',
              op: '=',
              parentField: 'id',
            },
            subquery: {
              alias: 'labels',
              orderBy: [
                ['issueId', 'asc'],
                ['labelId', 'asc'],
              ],
              related: [
                {
                  correlation: {
                    childField: 'id',
                    op: '=',
                    parentField: 'labelId',
                  },
                  hidden: true,
                  subquery: {
                    alias: 'labels',
                    orderBy: [['id', 'asc']],
                    table: 'label',
                  },
                },
              ],
              table: 'issueLabel',
            },
          },
        ],
        start: {
          exclusive: true,
          row: {
            id: '101',
            title: 'Issue 1',
          },
        },
        table: 'issue',
        where: [
          {
            field: 'ownerId',
            op: 'IN',
            type: 'simple',
            value: ['001', '002', '003'],
          },
          {
            field: 'closed',
            op: '=',
            type: 'simple',
            value: false,
          },
        ],
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: unknown[] = [];
    view.addListener(data => {
      rows = [...data].map(row => ({
        ...row,
        owner: [...row.owner],
        comments: [...row.comments].map(comment => ({
          ...comment,
          revisions: [...comment.revisions],
        })),
        labels: [...row.labels].map(label => ({
          ...label,
        })),
      }));
    });
    expect(rows).toEqual([
      {
        closed: false,
        comments: [
          {
            authorId: '003',
            createdAt: 6,
            id: '206',
            issueId: '102',
            revisions: [],
            text: 'Comment 6',
          },
          {
            authorId: '002',
            createdAt: 5,
            id: '205',
            issueId: '102',
            revisions: [],
            text: 'Comment 5',
          },
        ],
        description: 'Description 2',
        id: '102',
        labels: [
          {
            id: '401',
            name: 'bug',
          },
          {
            id: '402',
            name: 'feature',
          },
        ],
        owner: [
          {
            id: '001',
            name: 'Alice',
          },
        ],
        ownerId: '001',
        title: 'Issue 2',
      },
      {
        closed: false,
        comments: [
          {
            authorId: '003',
            createdAt: 9,
            id: '209',
            issueId: '103',
            revisions: [
              {
                authorId: '001',
                commentId: '209',
                id: '303',
                text: 'Revision 3',
              },
            ],
            text: 'Comment 9',
          },
          {
            authorId: '002',
            createdAt: 8,
            id: '208',
            issueId: '103',
            revisions: [
              {
                authorId: '002',
                commentId: '208',
                id: '306',
                text: 'Revision 3',
              },
            ],
            text: 'Comment 8',
          },
        ],
        description: 'Description 3',
        id: '103',
        labels: [
          {
            id: '401',
            name: 'bug',
          },
        ],
        owner: [
          {
            id: '001',
            name: 'Alice',
          },
        ],
        ownerId: '001',
        title: 'Issue 3',
      },
      {
        closed: false,
        comments: [],
        description: 'Description 4',
        id: '104',
        labels: [],
        owner: [
          {
            id: '002',
            name: 'Bob',
          },
        ],
        ownerId: '002',
        title: 'Issue 4',
      },
      {
        closed: false,
        comments: [
          {
            authorId: '003',
            createdAt: 12,
            id: '212',
            issueId: '105',
            revisions: [],
            text: 'Comment 12',
          },
          {
            authorId: '002',
            createdAt: 11,
            id: '211',
            issueId: '105',
            revisions: [
              {
                authorId: '003',
                commentId: '211',
                id: '309',
                text: 'Revision 3',
              },
            ],
            text: 'Comment 11',
          },
        ],
        description: 'Description 5',
        id: '105',
        labels: [],
        owner: [
          {
            id: '002',
            name: 'Bob',
          },
        ],
        ownerId: '002',
        title: 'Issue 5',
      },
      {
        closed: false,
        comments: [],
        description: 'Description 9',
        id: '109',
        labels: [],
        owner: [
          {
            id: '003',
            name: 'Charlie',
          },
        ],
        ownerId: '003',
        title: 'Issue 9',
      },
    ]);
  });
});