import {mapAST} from '../../../zero-protocol/src/ast.ts';
import type {NameMapper} from '../../../zero-types/src/name-mapper.ts';
import {planQuery} from '../../../zql/src/planner/planner-builder.ts';
import type {ConnectionCostModel} from '../../../zql/src/planner/planner-connection.ts';
import type {PlanDebugger} from '../../../zql/src/planner/planner-debug.ts';
import {queryWithContext} from '../../../zql/src/query/query-internals.ts';
import type {AnyQuery} from '../../../zql/src/query/query.ts';

export function makeGetPlanAST(
  mapper: NameMapper,
  costModel: ConnectionCostModel,
) {
  return (q: AnyQuery, planDebugger?: PlanDebugger) => {
    const ast = queryWithContext(q, undefined).ast;
    return planQuery(mapAST(ast, mapper), costModel, planDebugger);
  };
}

// oxlint-disable-next-line no-explicit-any
export function pick(node: any, path: (string | number)[]) {
  let cur = node;
  for (const p of path) {
    cur = cur[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}
