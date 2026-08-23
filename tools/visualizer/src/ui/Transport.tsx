const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

export interface TransportProps {
  t: number;
  playing: boolean;
  speed: number;
  animated: boolean;
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
}

export function Transport(props: TransportProps) {
  return (
    <div className="transport">
      <div className="transport-buttons">
        <button type="button" onClick={props.onPrevious} disabled={!props.hasPrevious} title="Previous pass (Left arrow)">
          ◀
        </button>
        <button type="button" onClick={props.onPlayPause} title="Play through the remaining passes (Space)">
          {props.playing ? '❚❚' : '▶'}
        </button>
        <button type="button" onClick={props.onNext} disabled={!props.hasNext} title="Next pass (Right arrow)">
          ▶
        </button>
        <button type="button" onClick={props.onReplay} title="Replay this pass (R)">
          ⟲
        </button>
      </div>

      <input
        className="transport-scrub"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={props.t}
        onChange={event => props.onScrub(Number(event.target.value))}
        disabled={!props.animated}
        aria-label="Scrub the transition"
      />

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
    </div>
  );
}
