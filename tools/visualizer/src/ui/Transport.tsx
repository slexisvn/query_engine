const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

const PIN_HINT =
  'Hold this plan as the left-hand side, then pick any other pass to morph straight from one to the other.';

export interface TransportProps {
  t: number;
  playing: boolean;
  speed: number;
  animated: boolean;
  scrubbable: boolean;
  spotlight: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onScrub: (value: number) => void;
  onReplay: () => void;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSpeed: (speed: number) => void;
  onSpotlight: (spotlight: boolean) => void;
  pinnedLabel: string | null;
  onTogglePin: () => void;
}

export function Transport(props: TransportProps) {
  return (
    <div className="transport">
      <div className="transport-buttons">
        <button type="button" onClick={props.onPrevious} disabled={!props.hasPrevious} title="Previous pass (Left arrow)" aria-label="Previous pass">
          ⏮
        </button>
        <button type="button" onClick={props.onPlayPause} title="Play through the remaining passes (Space)" aria-label={props.playing ? 'Pause' : 'Play through the remaining passes'}>
          {props.playing ? '❚❚' : '▶'}
        </button>
        <button type="button" onClick={props.onNext} disabled={!props.hasNext} title="Next pass (Right arrow)" aria-label="Next pass">
          ⏭
        </button>
        <button type="button" onClick={props.onReplay} disabled={!props.scrubbable} title="Replay this pass (R)" aria-label="Replay this pass">
          ⟲
        </button>
        <button
          type="button"
          className={props.pinnedLabel === null ? 'transport-pin' : 'transport-pin selected'}
          onClick={props.onTogglePin}
          title={PIN_HINT}
          aria-label={props.pinnedLabel === null ? 'Pin this plan to compare against' : 'Release the pinned plan'}
        >
          {props.pinnedLabel === null ? 'pin' : 'unpin'}
        </button>
      </div>

      {props.pinnedLabel === null ? null : (
        <span className="transport-pinned">against {props.pinnedLabel}</span>
      )}

      {props.scrubbable ? (
        <div className="transport-scrubber">
          <span>before</span>
          <input
            className="transport-scrub"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={props.t}
            onChange={event => props.onScrub(Number(event.target.value))}
            disabled={!props.animated}
            aria-label="Scrub the transition from before the pass to after it"
          />
          <span>after</span>
        </div>
      ) : (
        <p className="transport-note">Text view shows the finished rewrite — switch to Tree to scrub through it.</p>
      )}

      {props.scrubbable ? (
        <div className="transport-options">
          <select
            className="transport-speed"
            value={props.speed}
            onChange={event => props.onSpeed(Number(event.target.value))}
            disabled={!props.animated}
            aria-label="Playback speed"
            title="Playback speed"
          >
            {SPEEDS.map(speed => (
              <option key={speed} value={speed}>{speed}× speed</option>
            ))}
          </select>
          <label title="Dim the nodes this pass did not touch">
            <input
              type="checkbox"
              checked={props.spotlight}
              onChange={event => props.onSpotlight(event.target.checked)}
            />
            spotlight
          </label>
        </div>
      ) : null}
    </div>
  );
}
