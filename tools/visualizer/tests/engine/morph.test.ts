import { describe, it, expect } from 'vitest';
import { buildMorph, contentAt, showsAfter } from '../../src/engine/morph.js';
import { sizePlanNode } from '../../src/ui/node-sizer.js';
import { JOIN_TOPN_QUERY, planViewsFor, trace } from './helpers.js';
import type { MorphFrame, MorphNode } from '../../src/engine/morph.js';

function frameFor(pass: string): MorphFrame {
  const { before, after, diff } = planViewsFor(trace(JOIN_TOPN_QUERY), pass);
  return buildMorph(before, after, diff, sizePlanNode);
}

function nodeOf(frame: MorphFrame, status: MorphNode['status']): MorphNode {
  const node = frame.nodes.find(candidate => candidate.status === status);
  if (!node) throw new Error(`no ${status} node in this frame`);
  return node;
}

describe('showsAfter', () => {
  it('switches sides at the midpoint of the morph', () => {
    expect(showsAfter(0)).toBe(false);
    expect(showsAfter(0.49)).toBe(false);
    expect(showsAfter(0.5)).toBe(true);
    expect(showsAfter(1)).toBe(true);
  });
});

describe('contentAt on a rewritten node', () => {
  const frame = frameFor('ExpressionSimplifier');
  const rewritten = nodeOf(frame, 'modified');

  it('hands back the pre-rewrite node while the canvas still draws it', () => {
    const resolved = contentAt(frame, rewritten.key, 0);

    expect(resolved).not.toBeNull();
    expect(resolved?.side).toBe('before');
    expect(resolved?.node).toBe(rewritten.fromNode);
  });

  it('follows the canvas across the midpoint to the rewritten node', () => {
    const resolved = contentAt(frame, rewritten.key, 1);

    expect(resolved?.side).toBe('after');
    expect(resolved?.node).toBe(rewritten.toNode);
    expect(resolved?.node.fullDetail).not.toBe(rewritten.fromNode?.fullDetail);
  });
});

describe('contentAt on nodes that exist on one side only', () => {
  it('keeps a removed node on the before side for the whole morph', () => {
    const frame = frameFor('TopNFusion');
    const removed = nodeOf(frame, 'removed');

    for (const t of [0, 0.5, 1]) {
      const resolved = contentAt(frame, removed.key, t);
      expect(resolved?.side).toBe('before');
      expect(resolved?.node).toBe(removed.fromNode);
    }
  });

  it('keeps an added node on the after side for the whole morph', () => {
    const frame = frameFor('TopNFusion');
    const added = nodeOf(frame, 'added');

    for (const t of [0, 0.5, 1]) {
      const resolved = contentAt(frame, added.key, t);
      expect(resolved?.side).toBe('after');
      expect(resolved?.node).toBe(added.toNode);
    }
  });
});

describe('contentAt on a key the frame no longer holds', () => {
  it('reports nothing rather than a node from another plan', () => {
    expect(contentAt(frameFor('ExpressionSimplifier'), 'no-such-key', 1)).toBeNull();
  });

  it('only ever hands back a node the frame itself holds', () => {
    const frame = frameFor('TopNFusion');
    const own = new Set(frame.nodes.flatMap(node => [node.fromNode, node.toNode]));

    for (const node of frame.nodes) {
      for (const t of [0, 0.5, 1]) {
        expect(own).toContain(contentAt(frame, node.key, t)?.node);
      }
    }
  });
});
