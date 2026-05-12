import { Snowflake, SkipForward } from 'lucide-react';

type Props = {
  mouse: { x: number; y: number } | null;
  imageDims: { w: number; h: number } | null;
  zoom: number;
  onSkip: () => void;
  onFreeze: () => void;
};

export function StatusBar({ mouse, imageDims, zoom, onSkip, onFreeze }: Props) {
  return (
    <div className="h-8 shrink-0 border-t border-neutral-800 bg-neutral-900 flex items-center px-3 text-xs text-neutral-400 gap-4">
      <span className="font-mono">
        {mouse ? `x: ${mouse.x.toFixed(0)}, y: ${mouse.y.toFixed(0)}` : 'x: —, y: —'}
      </span>
      <span className="font-mono">
        {imageDims ? `${imageDims.w} × ${imageDims.h}` : ''}
      </span>
      <span className="font-mono">zoom: {Math.round(zoom * 100)}%</span>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onSkip}
          className="px-2 py-1 rounded hover:bg-neutral-800 text-neutral-300 inline-flex items-center gap-1"
        >
          <SkipForward size={12} /> Skip
        </button>
        <button
          onClick={onFreeze}
          className="px-2 py-1 rounded bg-accent text-white inline-flex items-center gap-1 hover:bg-blue-600"
        >
          <Snowflake size={12} /> Freeze
        </button>
      </div>
    </div>
  );
}
