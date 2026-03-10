/**
 * State management — types, reducer, and React context.
 */

import React, { createContext, useContext } from "react";

// ── Types ──

export type Tab = "inbox" | "threads" | "fleet" | "sent" | "search";
export type FocusPanel = "sidebar" | "pane" | "command";

export interface WorkerInfo {
  name: string;
  status: string;
  perpetual: boolean;
  hasBms: boolean;
  unread: number;
  pane: string;
  runtime: string;
  sleepUntil?: string;
}

export interface PaneState {
  id: string;
  worker: string;
  tab: Tab;
  selectedIndex: number;
  scrollOffset: number;
  openMessage: any | null;
  openThread: any | null;
  messages: any[];
  threads: any[];
  loading: boolean;
  previousTab: Tab | null;
  searchQuery: string;
  selectedIds: Set<string>;
}

export interface UndoAction {
  type: "archive" | "trash";
  messageId: string;
  messageIds?: string[];
  paneIndex: number;
  expiresAt: number;
}

export interface ComposeFields {
  to: string;
  cc: string;
  subject: string;
  body: string;
  activeField: "to" | "cc" | "subject" | "body";
}

export interface AppState {
  tokenMap: Map<string, string>;
  directory: Record<string, string>;
  registry: Record<string, any>;
  workerList: WorkerInfo[];
  userToken: string;

  panes: PaneState[];
  activePaneIndex: number;
  splitDirection: "horizontal" | "vertical";

  focusedPanel: FocusPanel;
  sidebarIndex: number;

  commandMode: boolean;
  commandInput: string;
  showHelp: boolean;
  searchQuery: string;
  statusMessage: string;

  pendingG: boolean; // for gg detection
  tabCompletionIndex: number; // cycle through tab completions
  tabCompletionBase: string; // original input before tab cycling

  replyMode: boolean; // inline reply below message
  replyInput: string;
  replyAllMode: boolean;

  commandHistory: string[]; // previous commands for up/down cycling
  commandHistoryIndex: number; // -1 = not cycling, 0..N = position

  undoAction: UndoAction | null;
  composeMode: boolean;
  composeFields: ComposeFields;
  splitRatio: number;
}

// ── Actions ──

export type Action =
  | { type: "SET_WORKER_LIST"; workers: WorkerInfo[] }
  | { type: "SET_DIRECTORY"; directory: Record<string, string> }
  | { type: "SET_REGISTRY"; registry: Record<string, any> }
  | { type: "SET_TOKEN_MAP"; tokenMap: Map<string, string> }
  | { type: "SET_PANE_MESSAGES"; paneIndex: number; messages: any[] }
  | { type: "SET_PANE_THREADS"; paneIndex: number; threads: any[] }
  | { type: "SET_PANE_LOADING"; paneIndex: number; loading: boolean }
  | { type: "SET_PANE_TAB"; paneIndex: number; tab: Tab }
  | { type: "SET_PANE_WORKER"; paneIndex: number; worker: string }
  | { type: "CURSOR_DOWN" }
  | { type: "CURSOR_UP" }
  | { type: "GOTO_TOP" }
  | { type: "GOTO_BOTTOM" }
  | { type: "PAGE_DOWN"; pageSize: number }
  | { type: "PAGE_UP"; pageSize: number }
  | { type: "OPEN_MESSAGE"; message: any }
  | { type: "OPEN_THREAD"; thread: any }
  | { type: "CLOSE_DETAIL" }
  | { type: "FOCUS_SIDEBAR" }
  | { type: "FOCUS_PANE" }
  | { type: "FOCUS_COMMAND" }
  | { type: "CYCLE_FOCUS" }
  | { type: "ENTER_COMMAND" }
  | { type: "EXIT_COMMAND" }
  | { type: "SET_COMMAND_INPUT"; input: string }
  | { type: "TOGGLE_HELP" }
  | { type: "SET_STATUS"; message: string }
  | { type: "SIDEBAR_DOWN" }
  | { type: "SIDEBAR_UP" }
  | { type: "ADD_PANE"; worker: string; direction?: "horizontal" | "vertical" }
  | { type: "REMOVE_PANE"; paneIndex: number }
  | { type: "SET_ACTIVE_PANE"; index: number }
  | { type: "NEXT_PANE" }
  | { type: "SET_SEARCH"; query: string }
  | { type: "SET_PENDING_G"; pending: boolean }
  | { type: "UPDATE_UNREAD"; worker: string; count: number }
  | { type: "TAB_COMPLETE"; completions: string[] }
  | { type: "ENTER_REPLY" }
  | { type: "EXIT_REPLY" }
  | { type: "SET_REPLY_INPUT"; input: string }
  | { type: "SET_COMMAND_HISTORY"; history: string[] }
  | { type: "SET_COMMAND_HISTORY_INDEX"; index: number }
  | { type: "MARK_MESSAGE_READ"; paneIndex: number; messageId: string }
  | { type: "OPTIMISTIC_REMOVE_MESSAGE"; paneIndex: number; messageId: string }
  | { type: "OPTIMISTIC_REMOVE_MESSAGES"; paneIndex: number; messageIds: string[] }
  | { type: "OPTIMISTIC_TOGGLE_LABEL"; paneIndex: number; messageId: string; label: string; add: boolean }
  | { type: "SET_UNDO"; undo: UndoAction }
  | { type: "CLEAR_UNDO" }
  | { type: "ENTER_SEARCH_TAB" }
  | { type: "TOGGLE_SELECTION"; messageId: string }
  | { type: "CLEAR_SELECTION" }
  | { type: "ENTER_COMPOSE" }
  | { type: "EXIT_COMPOSE" }
  | { type: "SET_COMPOSE_FIELD"; field: "to" | "cc" | "subject" | "body"; value: string }
  | { type: "NEXT_COMPOSE_FIELD" }
  | { type: "ENTER_REPLY_ALL" }
  | { type: "EXIT_REPLY_ALL" }
  | { type: "RESIZE_PANE"; delta: number };

// ── Helpers ──

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function activePane(state: AppState): PaneState {
  return state.panes[state.activePaneIndex];
}

function listLength(pane: PaneState): number {
  if (pane.tab === "inbox" || pane.tab === "sent" || pane.tab === "search") return pane.messages.length;
  if (pane.tab === "threads") return pane.threads.length;
  return 0;
}

function updateActivePane(
  state: AppState,
  update: Partial<PaneState>
): AppState {
  const panes = [...state.panes];
  panes[state.activePaneIndex] = { ...panes[state.activePaneIndex], ...update };
  return { ...state, panes };
}

function updatePane(
  state: AppState,
  index: number,
  update: Partial<PaneState>
): AppState {
  const panes = [...state.panes];
  panes[index] = { ...panes[index], ...update };
  return { ...state, panes };
}

// ── Reducer ──

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_WORKER_LIST":
      return { ...state, workerList: action.workers };

    case "SET_DIRECTORY":
      return { ...state, directory: action.directory };

    case "SET_REGISTRY":
      return { ...state, registry: action.registry };

    case "SET_TOKEN_MAP":
      return { ...state, tokenMap: action.tokenMap };

    case "SET_PANE_MESSAGES":
      return updatePane(state, action.paneIndex, {
        messages: action.messages,
        loading: false,
      });

    case "SET_PANE_THREADS":
      return updatePane(state, action.paneIndex, {
        threads: action.threads,
        loading: false,
      });

    case "SET_PANE_LOADING":
      return updatePane(state, action.paneIndex, { loading: action.loading });

    case "SET_PANE_TAB": {
      return updatePane(state, action.paneIndex, {
        tab: action.tab,
        selectedIndex: 0,
        scrollOffset: 0,
        openMessage: null,
        openThread: null,
      });
    }

    case "SET_PANE_WORKER":
      return updatePane(state, action.paneIndex, {
        worker: action.worker,
        messages: [],
        threads: [],
        selectedIndex: 0,
        scrollOffset: 0,
        openMessage: null,
        openThread: null,
        loading: true,
      });

    case "CURSOR_DOWN": {
      if (state.focusedPanel !== "pane") return state;
      const pane = activePane(state);
      const max = listLength(pane) - 1;
      const newIndex = clamp(pane.selectedIndex + 1, 0, max);
      return updateActivePane(state, { selectedIndex: newIndex });
    }

    case "CURSOR_UP": {
      if (state.focusedPanel !== "pane") return state;
      const pane = activePane(state);
      const newIndex = clamp(pane.selectedIndex - 1, 0, listLength(pane) - 1);
      return updateActivePane(state, { selectedIndex: newIndex });
    }

    case "GOTO_TOP": {
      if (state.focusedPanel === "sidebar")
        return { ...state, sidebarIndex: 0, pendingG: false };
      if (state.focusedPanel !== "pane") return { ...state, pendingG: false };
      return updateActivePane(
        { ...state, pendingG: false },
        { selectedIndex: 0, scrollOffset: 0 }
      );
    }

    case "GOTO_BOTTOM": {
      if (state.focusedPanel === "sidebar") {
        const max = state.workerList.length - 1;
        return { ...state, sidebarIndex: clamp(max, 0, max) };
      }
      if (state.focusedPanel !== "pane") return state;
      const pane = activePane(state);
      const max = listLength(pane) - 1;
      return updateActivePane(state, { selectedIndex: clamp(max, 0, max) });
    }

    case "PAGE_DOWN": {
      if (state.focusedPanel !== "pane") return state;
      const pane = activePane(state);
      const max = listLength(pane) - 1;
      const newIndex = clamp(pane.selectedIndex + action.pageSize, 0, max);
      return updateActivePane(state, { selectedIndex: newIndex });
    }

    case "PAGE_UP": {
      if (state.focusedPanel !== "pane") return state;
      const pane = activePane(state);
      const newIndex = clamp(pane.selectedIndex - action.pageSize, 0, listLength(pane) - 1);
      return updateActivePane(state, { selectedIndex: newIndex });
    }

    case "OPEN_MESSAGE":
      return updateActivePane(state, {
        openMessage: action.message,
        openThread: null,
      });

    case "OPEN_THREAD":
      return updateActivePane(state, {
        openThread: action.thread,
        openMessage: null,
      });

    case "CLOSE_DETAIL":
      return updateActivePane(state, {
        openMessage: null,
        openThread: null,
      });

    case "FOCUS_SIDEBAR":
      return { ...state, focusedPanel: "sidebar" };

    case "FOCUS_PANE":
      return { ...state, focusedPanel: "pane" };

    case "FOCUS_COMMAND":
      return { ...state, focusedPanel: "command" };

    case "CYCLE_FOCUS": {
      const panels: FocusPanel[] =
        state.panes.length > 1
          ? ["sidebar", "pane", "pane"]
          : ["sidebar", "pane"];
      const currentIdx = panels.indexOf(state.focusedPanel);
      const nextIdx = (currentIdx + 1) % panels.length;

      // If we cycle through multiple panes
      if (
        panels[nextIdx] === "pane" &&
        state.focusedPanel === "pane" &&
        state.panes.length > 1
      ) {
        const nextPaneIdx =
          (state.activePaneIndex + 1) % state.panes.length;
        return {
          ...state,
          activePaneIndex: nextPaneIdx,
          focusedPanel: "pane",
        };
      }
      return { ...state, focusedPanel: panels[nextIdx] };
    }

    case "ENTER_COMMAND":
      return {
        ...state,
        commandMode: true,
        commandInput: "",
        focusedPanel: "command",
      };

    case "EXIT_COMMAND":
      return {
        ...state,
        commandMode: false,
        commandInput: "",
        focusedPanel: "pane",
      };

    case "SET_COMMAND_INPUT":
      return { ...state, commandInput: action.input, tabCompletionIndex: -1, tabCompletionBase: "" };

    case "TAB_COMPLETE": {
      if (action.completions.length === 0) return state;
      const nextIdx = (state.tabCompletionIndex + 1) % action.completions.length;
      const base = state.tabCompletionBase || state.commandInput;
      return {
        ...state,
        commandInput: action.completions[nextIdx],
        tabCompletionIndex: nextIdx,
        tabCompletionBase: base,
      };
    }

    case "TOGGLE_HELP":
      return { ...state, showHelp: !state.showHelp };

    case "SET_STATUS":
      return { ...state, statusMessage: action.message };

    case "SIDEBAR_DOWN": {
      const max = state.workerList.length - 1;
      return {
        ...state,
        sidebarIndex: clamp(state.sidebarIndex + 1, 0, max),
      };
    }

    case "SIDEBAR_UP":
      return {
        ...state,
        sidebarIndex: clamp(state.sidebarIndex - 1, 0, state.workerList.length - 1),
      };

    case "ADD_PANE": {
      const newPane: PaneState = {
        id: `pane-${Date.now()}`,
        worker: action.worker,
        tab: "inbox",
        selectedIndex: 0,
        scrollOffset: 0,
        openMessage: null,
        openThread: null,
        messages: [],
        threads: [],
        loading: true,
        previousTab: null,
        searchQuery: "",
        selectedIds: new Set(),
      };
      return {
        ...state,
        panes: [...state.panes, newPane],
        activePaneIndex: state.panes.length,
        splitDirection: action.direction || state.splitDirection,
        focusedPanel: "pane",
      };
    }

    case "REMOVE_PANE": {
      if (state.panes.length <= 1) return state;
      const panes = state.panes.filter((_, i) => i !== action.paneIndex);
      const newActive = clamp(
        state.activePaneIndex,
        0,
        panes.length - 1
      );
      return { ...state, panes, activePaneIndex: newActive };
    }

    case "SET_ACTIVE_PANE":
      return {
        ...state,
        activePaneIndex: clamp(action.index, 0, state.panes.length - 1),
      };

    case "NEXT_PANE":
      return {
        ...state,
        activePaneIndex:
          (state.activePaneIndex + 1) % state.panes.length,
        focusedPanel: "pane",
      };

    case "SET_SEARCH":
      return { ...state, searchQuery: action.query };

    case "SET_PENDING_G":
      return { ...state, pendingG: action.pending };

    case "UPDATE_UNREAD": {
      const workers = state.workerList.map((w) =>
        w.name === action.worker ? { ...w, unread: action.count } : w
      );
      return { ...state, workerList: workers };
    }

    case "ENTER_REPLY":
      return { ...state, replyMode: true, replyInput: "" };

    case "EXIT_REPLY":
      return { ...state, replyMode: false, replyInput: "" };

    case "SET_REPLY_INPUT":
      return { ...state, replyInput: action.input };

    case "SET_COMMAND_HISTORY":
      return { ...state, commandHistory: action.history };

    case "SET_COMMAND_HISTORY_INDEX":
      return { ...state, commandHistoryIndex: action.index };

    case "MARK_MESSAGE_READ": {
      const pane = state.panes[action.paneIndex];
      if (!pane) return state;
      const messages = pane.messages.map((m: any) =>
        m.id === action.messageId
          ? { ...m, labelIds: (m.labelIds || []).filter((l: string) => l !== "UNREAD") }
          : m
      );
      let openMessage = pane.openMessage;
      if (openMessage?.id === action.messageId) {
        openMessage = { ...openMessage, labelIds: (openMessage.labelIds || []).filter((l: string) => l !== "UNREAD") };
      }
      return updatePane(state, action.paneIndex, { messages, openMessage });
    }

    case "OPTIMISTIC_REMOVE_MESSAGE": {
      const pane = state.panes[action.paneIndex];
      if (!pane) return state;
      const messages = pane.messages.filter((m: any) => m.id !== action.messageId);
      const threads = pane.threads.filter((t: any) => t.id !== action.messageId);
      const selectedIndex = Math.min(pane.selectedIndex, Math.max(0, messages.length - 1));
      return updatePane(state, action.paneIndex, {
        messages, threads, selectedIndex,
        openMessage: null, openThread: null,
      });
    }

    case "OPTIMISTIC_REMOVE_MESSAGES": {
      const pane = state.panes[action.paneIndex];
      if (!pane) return state;
      const idSet = new Set(action.messageIds);
      const messages = pane.messages.filter((m: any) => !idSet.has(m.id));
      const threads = pane.threads.filter((t: any) => !idSet.has(t.id));
      const selectedIndex = Math.min(pane.selectedIndex, Math.max(0, messages.length - 1));
      return updatePane(state, action.paneIndex, {
        messages, threads, selectedIndex,
        openMessage: null, openThread: null,
        selectedIds: new Set(),
      });
    }

    case "OPTIMISTIC_TOGGLE_LABEL": {
      const pane = state.panes[action.paneIndex];
      if (!pane) return state;
      const messages = pane.messages.map((m: any) => {
        if (m.id !== action.messageId) return m;
        const labels = m.labelIds || [];
        return {
          ...m,
          labelIds: action.add
            ? [...labels, action.label]
            : labels.filter((l: string) => l !== action.label),
        };
      });
      let openMessage = pane.openMessage;
      if (openMessage?.id === action.messageId) {
        const labels = openMessage.labelIds || [];
        openMessage = {
          ...openMessage,
          labelIds: action.add
            ? [...labels, action.label]
            : labels.filter((l: string) => l !== action.label),
        };
      }
      return updatePane(state, action.paneIndex, { messages, openMessage });
    }

    case "SET_UNDO":
      return { ...state, undoAction: action.undo };

    case "CLEAR_UNDO":
      return { ...state, undoAction: null };

    case "ENTER_SEARCH_TAB": {
      const pane = activePane(state);
      return updateActivePane(state, {
        previousTab: pane.tab === "search" ? pane.previousTab : pane.tab,
        tab: "search",
        selectedIndex: 0,
        scrollOffset: 0,
        openMessage: null,
        openThread: null,
      });
    }

    case "TOGGLE_SELECTION": {
      const pane = activePane(state);
      const newSelected = new Set(pane.selectedIds);
      if (newSelected.has(action.messageId)) {
        newSelected.delete(action.messageId);
      } else {
        newSelected.add(action.messageId);
      }
      return updateActivePane(state, { selectedIds: newSelected });
    }

    case "CLEAR_SELECTION":
      return updateActivePane(state, { selectedIds: new Set() });

    case "ENTER_COMPOSE":
      return {
        ...state,
        composeMode: true,
        composeFields: { to: "", cc: "", subject: "", body: "", activeField: "to" },
      };

    case "EXIT_COMPOSE":
      return { ...state, composeMode: false };

    case "SET_COMPOSE_FIELD":
      return {
        ...state,
        composeFields: { ...state.composeFields, [action.field]: action.value },
      };

    case "NEXT_COMPOSE_FIELD": {
      const fields: Array<"to" | "cc" | "subject" | "body"> = ["to", "cc", "subject", "body"];
      const idx = fields.indexOf(state.composeFields.activeField);
      const nextField = fields[(idx + 1) % fields.length];
      return {
        ...state,
        composeFields: { ...state.composeFields, activeField: nextField },
      };
    }

    case "ENTER_REPLY_ALL":
      return { ...state, replyAllMode: true, replyMode: true, replyInput: "" };

    case "EXIT_REPLY_ALL":
      return { ...state, replyAllMode: false };

    case "RESIZE_PANE": {
      const newRatio = Math.max(0.2, Math.min(0.8, state.splitRatio + action.delta));
      return { ...state, splitRatio: newRatio };
    }

    default:
      return state;
  }
}

// ── Initial State Factory ──

export function createInitialState(
  tokenMap: Map<string, string>,
  registry: Record<string, any>,
  userToken: string
): AppState {
  return {
    tokenMap,
    directory: {},
    registry,
    workerList: [],
    userToken,
    panes: [
      {
        id: "pane-main",
        worker: "user",
        tab: "inbox",
        selectedIndex: 0,
        scrollOffset: 0,
        openMessage: null,
        openThread: null,
        messages: [],
        threads: [],
        loading: true,
        previousTab: null,
        searchQuery: "",
        selectedIds: new Set(),
      },
    ],
    activePaneIndex: 0,
    splitDirection: "vertical",
    focusedPanel: "pane",
    sidebarIndex: 0,
    commandMode: false,
    commandInput: "",
    showHelp: false,
    searchQuery: "",
    statusMessage: "",
    pendingG: false,
    tabCompletionIndex: -1,
    tabCompletionBase: "",
    replyMode: false,
    replyInput: "",
    replyAllMode: false,
    commandHistory: [],
    commandHistoryIndex: -1,
    undoAction: null,
    composeMode: false,
    composeFields: { to: "", cc: "", subject: "", body: "", activeField: "to" },
    splitRatio: 0.5,
  };
}

// ── Context ──

export const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState outside AppContext");
  return ctx;
}
