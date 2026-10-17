'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { PageAction } from './page-actions';

type Register = (actions: PageAction[]) => () => void;

const RegisterContext = createContext<Register>(() => () => {});
const ActionsContext = createContext<readonly PageAction[]>([]);

/** The shell's registry of the current page's create actions (#521). */
export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<readonly PageAction[]>([]);
  const register = useCallback<Register>((next) => {
    setActions(next);
    // Cleared on unmount, unless a newer registration already replaced it.
    return () => setActions((current) => (current === next ? [] : current));
  }, []);
  return (
    <RegisterContext.Provider value={register}>
      <ActionsContext.Provider value={actions}>
        {children}
      </ActionsContext.Provider>
    </RegisterContext.Provider>
  );
}

/** What the page on screen registered; read by the shell's capsule. */
export const useRegisteredPageActions = (): readonly PageAction[] =>
  useContext(ActionsContext);

/**
 * Offers `actions` on the capsule's `+` while the page is mounted. They are
 * re-registered only when their ids, labels or roles change; `onSelect` always
 * calls the page's latest handler, so the page need not memoise it.
 */
export function usePageActions(actions: readonly PageAction[]): void {
  const register = useContext(RegisterContext);
  const latest = useRef(actions);
  latest.current = actions;
  const key = actions
    .map((action) => `${action.id}:${action.label}:${action.operatorOnly}`)
    .join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for actions
  useEffect(
    () =>
      register(
        latest.current.map((action) => ({
          ...action,
          onSelect: () =>
            latest.current.find((each) => each.id === action.id)?.onSelect(),
        })),
      ),
    [register, key],
  );
}
