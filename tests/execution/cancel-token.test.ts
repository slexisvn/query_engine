import { describe, it, expect } from 'vitest';
import { CancelToken } from '../../src/execution/pipeline.js';

describe('CancelToken', () => {
  it('starts uncancelled and stays cancelled once cancelled', () => {
    const token = new CancelToken();

    expect(token.isCancelled).toBe(false);
    token.cancel();
    expect(token.isCancelled).toBe(true);
  });

  it('reports its parent\'s cancellation as its own', () => {
    const query = new CancelToken();
    const limit = new CancelToken(query);

    query.cancel();

    expect(limit.isCancelled).toBe(true);
  });

  it('does not report a child\'s cancellation to the parent', () => {
    const query = new CancelToken();
    const limit = new CancelToken(query);

    limit.cancel();

    expect(query.isCancelled).toBe(false);
  });

  it('follows an abort signal that fires later', () => {
    const controller = new AbortController();
    const token = CancelToken.fromSignal(controller.signal);

    expect(token.isCancelled).toBe(false);
    controller.abort();
    expect(token.isCancelled).toBe(true);
  });

  it('is born cancelled when the signal has already aborted', () => {
    const controller = new AbortController();
    controller.abort();

    expect(CancelToken.fromSignal(controller.signal).isCancelled).toBe(true);
  });

  it('stops following the signal once detached', () => {
    const controller = new AbortController();
    const token = CancelToken.fromSignal(controller.signal);

    token.detach();
    controller.abort();

    expect(token.isCancelled).toBe(false);
  });
});
