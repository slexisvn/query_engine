import { popcount, subsets } from './hypergraph.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class DPhypEnumerator {
  constructor(hyperGraph, costModel, cardinalityEstimator) {
    this.graph = hyperGraph;
    this.costModel = costModel;
    this.cardEstimator = cardinalityEstimator;
    this.dp = new Map();
  }

  solve() {
    for (const rel of this.graph.relations) {
      const cost = this.costModel.scanCost(rel.cardinality);
      this.dp.set(rel.mask, {
        plan: rel.plan,
        cardinality: rel.cardinality,
        totalCost: cost,
        mask: rel.mask,
      });
    }

    const n = this.graph.size;
    for (let size = 2; size <= n; size++) {
      this.enumerateSize(size);
    }

    return this.dp.get(this.graph.fullMask) || null;
  }

  enumerateSize(size) {
    const fullMask = this.graph.fullMask;

    for (let mask = 1; mask <= fullMask; mask++) {
      if (popcount(mask) !== size) continue;
      if (this.dp.has(mask)) continue;
      if (!this.graph.isConnected(mask)) continue;

      this.enumerateCsgCmpPairs(mask);
    }
  }

  enumerateCsgCmpPairs(combined) {
    for (let s1 = (combined - 1) & combined; s1 > 0; s1 = (s1 - 1) & combined) {
      const s2 = combined & ~s1;
      if (s2 === 0) continue;
      if (s1 > s2) continue;

      if (!this.dp.has(s1) || !this.dp.has(s2)) continue;
      if (!this.graph.isConnected(s1) || !this.graph.isConnected(s2)) continue;

      const preds = this.graph.findJoinPredicates(s1, s2);
      if (preds.length === 0) continue;

      this.emitPair(s1, s2, combined, preds);
    }
  }

  emitPair(s1Mask, s2Mask, combinedMask, predicates) {
    const s1 = this.dp.get(s1Mask);
    const s2 = this.dp.get(s2Mask);
    const joinCondition = combinePredicates(predicates);

    this.tryJoinOrder(s1, s2, combinedMask, joinCondition);
    this.tryJoinOrder(s2, s1, combinedMask, joinCondition);
  }

  tryJoinOrder(build, probe, combinedMask, joinCondition) {
    const joinCard = this.cardEstimator.estimateJoin(
      build.cardinality, probe.cardinality, joinCondition
    );

    const buildCard = build.cardinality;
    const probeCard = probe.cardinality;
    const joinCost = build.totalCost + probe.totalCost +
      this.costModel.hashJoinCost(buildCard, probeCard, joinCard);

    const existing = this.dp.get(combinedMask);
    if (!existing || joinCost < existing.totalCost) {
      this.dp.set(combinedMask, {
        plan: {
          type: 'HashJoin',
          buildSide: build.plan,
          probeSide: probe.plan,
          condition: joinCondition,
          buildCard: build.cardinality,
          probeCard: probe.cardinality,
        },
        cardinality: joinCard,
        totalCost: joinCost,
        mask: combinedMask,
      });
    }
  }
}

function combinePredicates(preds) {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];

  const unique = [];
  const seen = new Set();
  for (const p of preds) {
    const key = predicateKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  if (unique.length === 1) return unique[0];
  return unique.reduce((acc, p) => ({
    kind: BoundExprKind.BINARY,
    op: 'AND',
    left: acc,
    right: p,
    resultType: 'BOOLEAN',
  }));
}

function predicateKey(pred) {
  if (!pred) return '';
  if (pred.kind === BoundExprKind.COLUMN_REF) {
    return `${pred.tableAlias}.${pred.columnName}`;
  }
  if (pred.kind === BoundExprKind.BINARY) {
    return `${predicateKey(pred.left)}${pred.op}${predicateKey(pred.right)}`;
  }
  if (pred.kind === BoundExprKind.LITERAL) {
    return String(pred.value);
  }
  return JSON.stringify(pred).slice(0, 50);
}

export function runDPhyp(hyperGraph, costModel, cardinalityEstimator) {
  const enumerator = new DPhypEnumerator(hyperGraph, costModel, cardinalityEstimator);
  return enumerator.solve();
}
