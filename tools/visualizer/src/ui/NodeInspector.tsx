import { useMemo } from 'react';
import { Config } from '@engine/config.js';
import { explainEstimate } from '../engine/estimate-provenance.js';
import { qualifiedName } from '../engine/column-facts.js';
import { formatCount, formatSelectivity, formatValue } from './format.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { ColumnFact } from '../engine/column-facts.js';
import type { PlanViewNode } from '../engine/plan-view.js';

const INDEX_SELECTIVITY_THRESHOLD = Config.indexScanSelectivityThreshold;

const PROVENANCE_HINT =
  'The columns this operator filters or joins on, and the statistics the estimator had for them. '
  + 'A column with no histogram falls back to a fixed guess, which is where misestimates start.';

export interface NodeInspectorProps {
  node: PlanViewNode;
  root: LogicalPlanNode;
  statistics: Map<string, TableStats>;
  indexed: ReadonlySet<string>;
  indexScanned: ReadonlySet<string>;
  columnTypes: ReadonlyMap<string, string>;
  onClose: () => void;
}

function rangeOf(fact: ColumnFact): string {
  if (fact.min === null && fact.max === null) return '—';
  return `${formatValue(fact.min, fact.dataType ?? undefined)} … ${formatValue(fact.max, fact.dataType ?? undefined)}`;
}

function ColumnFacts({ facts }: { facts: readonly ColumnFact[] }) {
  if (facts.length === 0) return null;

  return (
    <table className="provenance" title={PROVENANCE_HINT}>
      <thead>
        <tr><th>column</th><th>distinct</th><th>nulls</th><th>range</th><th>histogram</th><th>index</th></tr>
      </thead>
      <tbody>
        {facts.map(fact => (
          <tr key={qualifiedName(fact)} className={fact.known ? '' : 'unknown'}>
            <td>{qualifiedName(fact)}</td>
            {fact.known ? (
              <>
                <td>{formatCount(fact.ndv)}</td>
                <td>{fact.nullFraction === null ? '—' : `${(fact.nullFraction * 100).toFixed(1)}%`}</td>
                <td>{rangeOf(fact)}</td>
                <td>{fact.histogramBuckets === null ? 'none' : `${fact.histogramBuckets} buckets`}</td>
                <td className={fact.indexed ? 'has-index' : ''}>{fact.indexed ? 'yes' : '—'}</td>
              </>
            ) : (
              <td colSpan={5} className="no-stats">no statistics — the estimator falls back to a fixed guess</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function NodeInspector({ node, root, statistics, indexed, indexScanned, columnTypes, onClose }: NodeInspectorProps) {
  const provenance = useMemo(
    () => explainEstimate(node, root, statistics, indexed, indexScanned, columnTypes),
    [columnTypes, indexScanned, indexed, node, root, statistics],
  );

  return (
    <section className="node-inspector">
      <h4>
        {node.title}
        <button type="button" aria-label="Close the node details" onClick={onClose}>×</button>
      </h4>
      {node.fullDetail ? <code>{node.fullDetail}</code> : null}
      <p>
        <span>planner estimate</span>
        <span className="estimate-maths">
          {provenance.inputRows === null
            ? `${formatCount(provenance.outputRows)} rows`
            : `${formatCount(provenance.inputRows)} in × ${formatSelectivity(provenance.selectivity)} = ${formatCount(provenance.outputRows)} rows`}
        </span>
      </p>
      <ColumnFacts facts={provenance.facts} />
      {provenance.readsSequentially ? (
        <p className="index-hint">
          An index covers one of these columns, and this filter still reads the table sequentially.
          IndexSelection only swaps in an index when it estimates the predicate keeps at most{' '}
          {(INDEX_SELECTIVITY_THRESHOLD * 100).toFixed(0)}% of the table — a wide range is cheaper to scan.
        </p>
      ) : null}
    </section>
  );
}
