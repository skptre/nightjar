import { useEffect, useCallback, useRef } from 'react';
import type { PostingAction } from '@/views/Feed/PostingRow';

const NAV_THROTTLE_MS = 50;

interface UseKeyboardOptions {
  postingIds: string[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onAction: (id: string, action: PostingAction) => void;
  onSearchFocus: () => void;
  onEscape: () => void;
  disabled: boolean;
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

export function useKeyboard({
  postingIds,
  selectedIndex,
  onSelectIndex,
  onAction,
  onSearchFocus,
  onEscape,
  disabled,
}: UseKeyboardOptions): void {
  const optionsRef = useRef<UseKeyboardOptions>({
    postingIds,
    selectedIndex,
    onSelectIndex,
    onAction,
    onSearchFocus,
    onEscape,
    disabled,
  });

  optionsRef.current = {
    postingIds,
    selectedIndex,
    onSelectIndex,
    onAction,
    onSearchFocus,
    onEscape,
    disabled,
  };

  const lastNavTime = useRef(0);

  const handleKeyDown = useCallback((e: KeyboardEvent): void => {
    const opts = optionsRef.current;

    if (e.key === 'Escape') {
      opts.onEscape();
      return;
    }

    if (opts.disabled || isInputFocused()) return;
    if (opts.postingIds.length === 0) return;

    const currentId = opts.postingIds[opts.selectedIndex];

    switch (e.key) {
      case 'j':
      case 'ArrowDown': {
        e.preventDefault();
        const now = Date.now();
        if (now - lastNavTime.current < NAV_THROTTLE_MS) return;
        lastNavTime.current = now;
        const next = Math.min(opts.selectedIndex + 1, opts.postingIds.length - 1);
        opts.onSelectIndex(next);
        break;
      }
      case 'k':
      case 'ArrowUp': {
        e.preventDefault();
        const now = Date.now();
        if (now - lastNavTime.current < NAV_THROTTLE_MS) return;
        lastNavTime.current = now;
        const prev = Math.max(opts.selectedIndex - 1, 0);
        opts.onSelectIndex(prev);
        break;
      }
      case 's': {
        if (currentId) opts.onAction(currentId, 'save');
        break;
      }
      case 'x': {
        if (currentId) opts.onAction(currentId, 'skip');
        break;
      }
      case 'o': {
        if (currentId) opts.onAction(currentId, 'open');
        break;
      }
      case 'a': {
        if (currentId) opts.onAction(currentId, 'apply');
        break;
      }
      case '/': {
        e.preventDefault();
        opts.onSearchFocus();
        break;
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
