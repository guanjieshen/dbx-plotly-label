import { X } from 'lucide-react';
import { useEditor } from '../store/editor';

const ROWS: [string, string][] = [
  ['V', 'Select tool'],
  ['R', 'Rectangle tool'],
  ['C', 'Circle tool'],
  ['P', 'Pin tool'],
  ['1-9', 'Pick label class'],
  ['Del / Backspace', 'Delete selected shape'],
  ['Z / Y', 'Undo / redo (planned)'],
  ['Space (hold)', 'Pan view'],
  ['Cmd/Ctrl + scroll', 'Zoom'],
  ['Enter', 'Freeze + advance'],
  ['S', 'Skip current'],
  ['[ / ]', 'Prev / next graph'],
  ['?', 'Show this dialog'],
];

export function ShortcutsModal() {
  const editor = useEditor();
  if (!editor.shortcutsOpen) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center"
      onClick={() => editor.setShortcutsOpen(false)}
    >
      <div
        className="w-[480px] bg-neutral-900 border border-neutral-800 rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 flex items-center justify-between px-3 border-b border-neutral-800">
          <div className="font-semibold text-sm">Keyboard shortcuts</div>
          <button
            onClick={() => editor.setShortcutsOpen(false)}
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1.5 text-sm">
          {ROWS.map(([k, d]) => (
            <>
              <kbd className="px-2 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-xs font-mono text-neutral-300 w-fit">
                {k}
              </kbd>
              <span className="text-neutral-400">{d}</span>
            </>
          ))}
        </div>
      </div>
    </div>
  );
}
