import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery } from './useMediaQuery.js';

export interface Tween {
  t: number;
  playing: boolean;
  play: (onComplete?: () => void) => void;
  pause: () => void;
  seek: (value: number) => void;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION);
}

export function useTween(durationMs: number, animated: boolean): Tween {
  const [t, setT] = useState(1);
  const [playing, setPlaying] = useState(false);
  const frame = useRef(0);
  const onComplete = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  useEffect(() => cancel, [cancel]);

  const run = useCallback((startValue: number, complete?: () => void) => {
    cancel();
    if (!animated || durationMs <= 0 || startValue >= 1) {
      setT(1);
      setPlaying(false);
      complete?.();
      return;
    }

    onComplete.current = complete ?? null;
    const startedAt = performance.now();
    setT(startValue);
    setPlaying(true);

    const tick = (now: number): void => {
      const value = startValue + (now - startedAt) / durationMs;
      if (value >= 1) {
        setT(1);
        setPlaying(false);
        const finished = onComplete.current;
        onComplete.current = null;
        finished?.();
        return;
      }
      setT(value);
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
  }, [animated, cancel, durationMs]);

  return {
    t,
    playing,
    play: useCallback((complete?: () => void) => run(0, complete), [run]),
    pause: useCallback(() => {
      cancel();
      setPlaying(false);
    }, [cancel]),
    seek: useCallback((value: number) => {
      cancel();
      setPlaying(false);
      onComplete.current = null;
      setT(Math.min(1, Math.max(0, value)));
    }, [cancel]),
  };
}
