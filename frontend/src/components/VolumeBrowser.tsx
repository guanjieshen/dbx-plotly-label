import { useEffect, useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen, Search, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { useEditor } from '../store/editor';
import { cn } from '../lib/cn';

type Filter = 'all' | 'todo' | 'done';

export function VolumeBrowser() {
  const editor = useEditor();
  const [filter, setFilter] = useState<Filter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Debounce search input → server query
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  if (!editor.browserOpen) return null;
  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex"
      onClick={() => editor.setBrowserOpen(false)}
    >
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

        {/* Filter chips + search */}
        <div className="px-3 py-2 border-b border-neutral-800 space-y-2">
          <div className="flex items-center gap-1">
            <FilterChip
              label="All"
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            <FilterChip
              label="To do"
              active={filter === 'todo'}
              dotClass="bg-amber-400"
              onClick={() => setFilter('todo')}
            />
            <FilterChip
              label="Done"
              active={filter === 'done'}
              dotClass="bg-emerald-400"
              onClick={() => setFilter('done')}
            />
          </div>
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
            />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by file name…"
              className="w-full bg-neutral-800 border border-neutral-700 rounded pl-7 pr-7 py-1.5 text-xs text-neutral-100 focus:outline-none focus:border-accent"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scroll-soft p-2 text-sm">
          {search ? (
            <SearchResults q={search} filter={filter} />
          ) : (
            <FolderNode path="" depth={0} initiallyOpen filter={filter} />
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  dotClass,
  onClick,
}: {
  label: string;
  active: boolean;
  dotClass?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'text-[11px] px-2 py-0.5 rounded-full border inline-flex items-center gap-1.5',
        active
          ? 'bg-accent/15 text-accent border-accent/40'
          : 'bg-neutral-800 text-neutral-400 border-neutral-700 hover:text-neutral-200',
      )}
    >
      {dotClass && <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />}
      {label}
    </button>
  );
}

function statusVisible(status: string | null | undefined, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return status === 'done';
  if (filter === 'todo') return status !== 'done';
  return true;
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  // Color + label per status. Null/undefined = "new" (not yet in graphs).
  let dot = 'bg-neutral-500';
  let text = '';
  if (status === 'done') {
    dot = 'bg-emerald-400';
    text = 'done';
  } else if (status === 'in_progress') {
    dot = 'bg-amber-400';
    text = 'in progress';
  } else if (status === 'skipped') {
    dot = 'bg-red-400';
    text = 'skipped';
  } else if (status === 'unlabelled') {
    dot = 'bg-neutral-500';
    text = 'to do';
  } else if (status == null) {
    dot = 'bg-blue-400';
    text = 'new';
  } else {
    text = status;
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-neutral-400 shrink-0"
      title={text}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {text}
    </span>
  );
}

function SearchResults({ q, filter }: { q: string; filter: Filter }) {
  const editor = useEditor();
  const sq = useQuery({
    queryKey: ['volume-search', q],
    queryFn: () => api.volumeSearch(q),
    enabled: !!q,
  });
  if (sq.isLoading) {
    return <div className="text-xs text-neutral-500 italic">searching…</div>;
  }
  const items = (sq.data?.entries || []).filter((e) => statusVisible(e.status, filter));
  if (items.length === 0) {
    return (
      <div className="text-xs text-neutral-500 italic">No files match.</div>
    );
  }
  return (
    <div className="space-y-0.5">
      {items.map((e) => (
        <button
          key={e.path}
          onClick={() => {
            editor.setCurrentGraphPath(e.path);
            editor.setBrowserOpen(false);
          }}
          className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-800 text-neutral-300 text-left"
        >
          <File size={14} className="text-neutral-500 shrink-0" />
          <span className="truncate flex-1 text-xs">{e.name}</span>
          <StatusBadge status={e.status} />
        </button>
      ))}
    </div>
  );
}

function FolderNode({
  path,
  depth,
  initiallyOpen = false,
  filter,
}: {
  path: string;
  depth: number;
  initiallyOpen?: boolean;
  filter: Filter;
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
          className={cn(
            'transition-transform shrink-0 text-neutral-500',
            open && 'rotate-90',
          )}
        />
        {open ? (
          <FolderOpen size={14} className="text-amber-400" />
        ) : (
          <Folder size={14} className="text-amber-400" />
        )}
        <span className="truncate">{name}</span>
      </button>
      {open && q.data && (
        <div>
          {q.data.entries.map((e) => {
            if (e.is_dir) {
              return (
                <FolderNode
                  key={e.path}
                  path={e.path.replace(/^\/Volumes\/[^/]+\/[^/]+\/[^/]+\/?/, '')}
                  depth={depth + 1}
                  filter={filter}
                />
              );
            }
            if (!statusVisible(e.status, filter)) return null;
            return (
              <button
                key={e.path}
                onClick={() => {
                  editor.setCurrentGraphPath(e.path);
                  editor.setBrowserOpen(false);
                }}
                className="w-full flex items-center gap-2 px-1 py-1 rounded hover:bg-neutral-800 text-neutral-300 text-left"
                style={{ paddingLeft: (depth + 1) * 12 + 14 }}
              >
                <File size={14} className="text-neutral-500 shrink-0" />
                <span className="truncate flex-1">{e.name}</span>
                <StatusBadge status={e.status} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
