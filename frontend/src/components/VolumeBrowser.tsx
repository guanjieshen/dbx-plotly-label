import { useEffect, useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { useEditor } from '../store/editor';
import { cn } from '../lib/cn';

export function VolumeBrowser() {
  const editor = useEditor();
  if (!editor.browserOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex" onClick={() => editor.setBrowserOpen(false)}>
      <div
        className="w-96 h-full bg-neutral-900 border-r border-neutral-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 px-3 flex items-center justify-between border-b border-neutral-800">
          <div className="font-semibold text-sm">Browse Volume</div>
          <button
            onClick={() => editor.setBrowserOpen(false)}
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-soft p-2 text-sm">
          <FolderNode path="" depth={0} initiallyOpen />
        </div>
      </div>
    </div>
  );
}

function FolderNode({
  path,
  depth,
  initiallyOpen = false,
}: {
  path: string;
  depth: number;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const editor = useEditor();

  const q = useQuery({
    queryKey: ['volume', path],
    queryFn: () => api.volumeTree(path),
    enabled: open,
  });

  const name = path ? path.split('/').filter(Boolean).pop() : '/ (root)';

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-1 px-1 py-1 rounded hover:bg-neutral-800 text-neutral-300',
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <ChevronRight
          size={12}
          className={cn('transition-transform shrink-0 text-neutral-500', open && 'rotate-90')}
        />
        {open ? <FolderOpen size={14} className="text-amber-400" /> : <Folder size={14} className="text-amber-400" />}
        <span className="truncate">{name}</span>
      </button>
      {open && q.data && (
        <div>
          {q.data.entries.map((e) =>
            e.is_dir ? (
              <FolderNode
                key={e.path}
                path={e.path.replace(/^\/Volumes\/[^/]+\/[^/]+\/[^/]+\/?/, '')}
                depth={depth + 1}
              />
            ) : (
              <button
                key={e.path}
                onClick={() => {
                  editor.setCurrentGraphPath(e.path);
                  editor.setBrowserOpen(false);
                }}
                className="w-full flex items-center gap-1 px-1 py-1 rounded hover:bg-neutral-800 text-neutral-300 text-left"
                style={{ paddingLeft: (depth + 1) * 12 + 14 }}
              >
                <File size={14} className="text-neutral-500 shrink-0" />
                <span className="truncate">{e.name}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
