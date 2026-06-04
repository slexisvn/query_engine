import { describe, it, expect } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { PhysicalStrategy } from '../../src/planner/logical-plan.js';

describe('Physical Operators', () => {
  it('executes Merge Join correctly', async () => {
    const catalog = {
      listTables: () => ['LEFT_T', 'RIGHT_T'],
      getTable: (name) => {
        name = name.toUpperCase();
        if (name === 'LEFT_T') return { name: 'LEFT_T', columns: [{ name: 'id', dataType: 'INT32' }, { name: 'val', dataType: 'VARCHAR' }] };
        if (name === 'RIGHT_T') return { name: 'RIGHT_T', columns: [{ name: 'id', dataType: 'INT32' }, { name: 'val2', dataType: 'VARCHAR' }] };
        return null;
      },
      getTableStorage: (name) => {
        name = name.toUpperCase();
        if (name === 'LEFT_T') {
          return {
            getSchema: () => [{ name: 'id', dataType: 'INT32' }, { name: 'val', dataType: 'VARCHAR' }],
            rowCount: () => 3,
            scan: function* () {
              yield {
                size: 3,
                columns: [
                  { get: (i) => [1, 2, 4][i], dataType: 'INT32' },
                  { get: (i) => ['a', 'b', 'd'][i], dataType: 'VARCHAR' }
                ],
                activeRowIndex: (i) => i
              };
            }
          };
        }
        if (name === 'RIGHT_T') {
          return {
            getSchema: () => [{ name: 'id', dataType: 'INT32' }, { name: 'val2', dataType: 'VARCHAR' }],
            rowCount: () => 3,
            scan: function* () {
              yield {
                size: 3,
                columns: [
                  { get: (i) => [1, 2, 3][i], dataType: 'INT32' },
                  { get: (i) => ['x', 'y', 'z'][i], dataType: 'VARCHAR' }
                ],
                activeRowIndex: (i) => i
              };
            }
          };
        }
      }
    };
    const engine = new QueryEngine(catalog, { statistics: new Map() });

    const ast = engine.parseSQL(`SELECT l.id, l.val, r.val2 FROM left_t l JOIN right_t r ON l.id = r.id`);
    const bound = engine.bind(ast);
    const logical = engine.plan(bound);
    const optimized = engine.optimize(logical);

    let joinNode = optimized.children[0];
    if (joinNode.type === 'Project') joinNode = joinNode.children[0];
    joinNode.physicalStrategy = PhysicalStrategy.MERGE;

        const result = await engine.executor.executePlan(optimized);

    const rows = [];
    for (const chunk of result.chunks) {
      for (let i = 0; i < chunk.size; i++) {
        rows.push([
          chunk.columns[0].get(chunk.activeRowIndex(i)),
          chunk.columns[1].get(chunk.activeRowIndex(i)),
          chunk.columns[2].get(chunk.activeRowIndex(i))
        ]);
      }
    }

        expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe(1);
    expect(rows[0][1]).toBe('a');
    expect(rows[0][2]).toBe('x');
    expect(rows[1][0]).toBe(2);
    expect(rows[1][1]).toBe('b');
    expect(rows[1][2]).toBe('y');
  });

  it('executes Stream Aggregate correctly', async () => {
    const catalog = {
      listTables: () => ['T'],
      getTable: (name) => {
        name = name.toUpperCase();
        if (name === 'T') return { name: 'T', columns: [{ name: 'grp', dataType: 'INT32' }, { name: 'val', dataType: 'INT32' }] };
        return null;
      },
      getTableStorage: (name) => {
        return {
          getSchema: () => [{ name: 'grp', dataType: 'INT32' }, { name: 'val', dataType: 'INT32' }],
          rowCount: () => 5,
          scan: function* () {
            yield {
              size: 5,
              columns: [
                { get: (i) => [1, 1, 2, 2, 2][i], dataType: 'INT32' },
                { get: (i) => [10, 20, 30, 40, 50][i], dataType: 'INT32' }
              ],
              activeRowIndex: (i) => i
            };
          }
        };
      }
    };
    const engine = new QueryEngine(catalog, { statistics: new Map() });

        const ast = engine.parseSQL(`SELECT grp, SUM(val) FROM t GROUP BY grp`);
    const bound = engine.bind(ast);
    const logical = engine.plan(bound);
    const optimized = engine.optimize(logical);

    let aggNode = optimized.children[0];
    if (aggNode.type === 'Project') aggNode = aggNode.children[0];
    aggNode.physicalStrategy = PhysicalStrategy.STREAM;

        const result = await engine.executor.executePlan(optimized);

        const rows = [];
    for (const chunk of result.chunks) {
      for (let i = 0; i < chunk.size; i++) {
        rows.push([
          chunk.columns[0].get(chunk.activeRowIndex(i)),
          chunk.columns[1].get(chunk.activeRowIndex(i))
        ]);
      }
    }

        expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe(1);
    expect(rows[0][1]).toBe(30);
    expect(rows[1][0]).toBe(2);
    expect(rows[1][1]).toBe(120);
  });
});
