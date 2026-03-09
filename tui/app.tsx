import React, { useReducer, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { colors } from "./theme.js";
import {
  reducer,
  createInitialState,
  AppContext,
  type AppState,
  type Tab,
} from "./state.js";
import {
  loadRegistry,
  loadTokenMap,
  fetchDirectory,
  fetchInbox,
  fetchSent,
  fetchThreads,
  fetchThread,
  fetchMessage,
  fetchUnreadCount,
  sendMessage,
  archiveMessage,
  starMessage,
  trashMessage,
  searchMessages,
} from "./bms.js";
import { Sidebar } from "./components/Sidebar.js";
import { MainArea } from "./components/MainArea.js";
import { CommandBar } from "./components/CommandBar.js";
import { HelpOverlay } from "./components/HelpOverlay.js";

const SIDEBAR_WIDTH = 18;
const POLL_INTERVAL = 15000; // 15s to avoid rate limits
const MAX_CONCURRENT_UNREAD = 3; // batch unread fetches

export function App({
  initialTokenMap,
  initialRegistry,
  userToken,
}: {
  initialTokenMap: Map<string, string>;
  initialRegistry: Record<string, any>;
  userToken: string;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows || 24;
  const cols = stdout?.columns || 80;

  const [state, dispatch] = useReducer(
    reducer,
    createInitialState(initialTokenMap, initialRegistry, userToken)
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Get token for a worker ──
  const getToken = useCallback(
    (worker: string): string => {
      if (worker === "user") return stateRef.current.userToken;
      return stateRef.current.tokenMap.get(worker) || stateRef.current.userToken;
    },
    []
  );

  // ── Fetch data for a pane ──
  const refreshPane = useCallback(
    async (paneIndex: number) => {
      const s = stateRef.current;
      const pane = s.panes[paneIndex];
      if (!pane) return;

      const token = getToken(pane.worker);
      try {
        if (pane.tab === "inbox") {
          const msgs = await fetchInbox(token);
          dispatch({ type: "SET_PANE_MESSAGES", paneIndex, messages: msgs });
        } else if (pane.tab === "sent") {
          const msgs = await fetchSent(token);
          dispatch({ type: "SET_PANE_MESSAGES", paneIndex, messages: msgs });
        } else if (pane.tab === "threads") {
          const threads = await fetchThreads(token);
          dispatch({ type: "SET_PANE_THREADS", paneIndex, threads });
        }
        // fleet tab reads from registry, no fetch needed
        if (pane.tab === "fleet") {
          dispatch({ type: "SET_PANE_LOADING", paneIndex, loading: false });
        }
      } catch (e: any) {
        dispatch({
          type: "SET_STATUS",
          message: `Error: ${e.message?.slice(0, 60)}`,
        });
        dispatch({ type: "SET_PANE_LOADING", paneIndex, loading: false });
      }
    },
    [getToken]
  );

  // ── Refresh all panes + sidebar ──
  const refreshAll = useCallback(async () => {
    // Refresh registry
    const reg = loadRegistry();
    const tMap = loadTokenMap(reg);
    dispatch({ type: "SET_REGISTRY", registry: reg });
    dispatch({ type: "SET_TOKEN_MAP", tokenMap: tMap });

    // Build worker list with unread counts
    const workers = Object.entries(reg)
      .filter(([k]) => k !== "_config")
      .map(([name, w]: [string, any]) => ({
        name,
        status: w.status || "idle",
        perpetual: !!w.perpetual,
        hasBms: !!w.bms_token,
        unread: 0,
        pane: w.pane_id || "",
        runtime: w.custom?.runtime || "claude",
        sleepUntil: w.custom?.sleep_until,
      }));

    // Fetch unread counts in batches to avoid rate limits
    const withBms = workers.filter((w) => w.hasBms);
    for (let i = 0; i < withBms.length; i += MAX_CONCURRENT_UNREAD) {
      const batch = withBms.slice(i, i + MAX_CONCURRENT_UNREAD);
      await Promise.all(
        batch.map(async (w) => {
          const token = tMap.get(w.name) || "";
          if (!token) return;
          try {
            w.unread = await fetchUnreadCount(token);
          } catch {}
        })
      );
    }
    dispatch({ type: "SET_WORKER_LIST", workers });

    // Refresh directory
    const dir = await fetchDirectory(
      stateRef.current.userToken
    );
    dispatch({ type: "SET_DIRECTORY", directory: dir });

    // Refresh all panes
    const s = stateRef.current;
    await Promise.all(s.panes.map((_, i) => refreshPane(i)));
  }, [refreshPane]);

  // ── Initial load ──
  useEffect(() => {
    refreshAll();
  }, []);

  // ── Polling ──
  useEffect(() => {
    const timer = setInterval(refreshAll, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refreshAll]);

  // ── Clear status messages after 3s ──
  useEffect(() => {
    if (state.statusMessage) {
      const t = setTimeout(
        () => dispatch({ type: "SET_STATUS", message: "" }),
        3000
      );
      return () => clearTimeout(t);
    }
  }, [state.statusMessage]);

  // ── gg timeout ──
  useEffect(() => {
    if (state.pendingG) {
      const t = setTimeout(
        () => dispatch({ type: "SET_PENDING_G", pending: false }),
        500
      );
      return () => clearTimeout(t);
    }
  }, [state.pendingG]);

  // ── Command execution ──
  const executeCommand = useCallback(
    async (cmd: string) => {
      const parts = cmd.trim().split(/\s+/);
      const verb = parts[0]?.toLowerCase();

      dispatch({ type: "EXIT_COMMAND" });

      try {
        if (verb === "q" || verb === "quit") {
          exit();
          return;
        }

        if (verb === "vsplit" || verb === "hsplit") {
          const worker = parts[1] || "user";
          dispatch({
            type: "ADD_PANE",
            worker,
            direction: verb === "vsplit" ? "vertical" : "horizontal",
          });
          // Fetch data for new pane after state update
          const newPaneIdx = stateRef.current.panes.length; // will be this after dispatch
          setTimeout(() => refreshPane(newPaneIdx), 100);
          return;
        }

        if (verb === "close") {
          const s = stateRef.current;
          if (s.panes.length > 1) {
            dispatch({ type: "REMOVE_PANE", paneIndex: s.activePaneIndex });
          } else {
            dispatch({
              type: "SET_STATUS",
              message: "Cannot close last pane",
            });
          }
          return;
        }

        if (verb === "as") {
          const worker = parts[1];
          if (!worker) {
            dispatch({ type: "SET_STATUS", message: "Usage: :as <worker>" });
            return;
          }
          const target = worker === "me" ? "user" : worker;

          // Fuzzy match
          const s = stateRef.current;
          let matchedWorker = target;
          if (!s.tokenMap.has(target) && target !== "user") {
            const matches = [...s.tokenMap.keys()].filter((k) =>
              k.includes(target)
            );
            if (matches.length === 1) {
              matchedWorker = matches[0];
            } else if (matches.length > 1) {
              dispatch({
                type: "SET_STATUS",
                message: `Ambiguous: ${matches.join(", ")}`,
              });
              return;
            } else {
              dispatch({
                type: "SET_STATUS",
                message: `Unknown worker: ${target}`,
              });
              return;
            }
          }

          dispatch({
            type: "SET_PANE_WORKER",
            paneIndex: s.activePaneIndex,
            worker: matchedWorker,
          });
          setTimeout(() => refreshPane(s.activePaneIndex), 50);
          dispatch({
            type: "SET_STATUS",
            message: `Switched to ${matchedWorker}`,
          });
          return;
        }

        if (verb === "send") {
          const to = parts[1];
          const subject = parts.slice(2).join(" ");
          if (!to || !subject) {
            dispatch({
              type: "SET_STATUS",
              message: "Usage: :send <worker> <subject>",
            });
            return;
          }

          // Resolve recipient
          const dir = await fetchDirectory(stateRef.current.userToken);
          const accounts = Object.entries(dir);
          const found = accounts.find(
            ([, name]) => name.toLowerCase() === to.toLowerCase()
          );
          const toId = found ? found[0] : to;

          await sendMessage(stateRef.current.userToken, [toId], subject, subject);
          dispatch({ type: "SET_STATUS", message: `Sent to ${to}` });
          return;
        }

        if (verb === "search") {
          const query = parts.slice(1).join(" ");
          if (!query) {
            dispatch({
              type: "SET_STATUS",
              message: "Usage: :search <query>",
            });
            return;
          }
          const s = stateRef.current;
          const pane = s.panes[s.activePaneIndex];
          const token = getToken(pane.worker);
          const results = await searchMessages(token, query);
          dispatch({
            type: "SET_PANE_MESSAGES",
            paneIndex: s.activePaneIndex,
            messages: results,
          });
          dispatch({
            type: "SET_PANE_TAB",
            paneIndex: s.activePaneIndex,
            tab: "inbox",
          });
          dispatch({
            type: "SET_STATUS",
            message: `Search: "${query}" — ${results.length} results`,
          });
          return;
        }

        if (verb === "reply") {
          const body = parts.slice(1).join(" ");
          if (!body) {
            dispatch({
              type: "SET_STATUS",
              message: "Usage: :reply <message>",
            });
            return;
          }
          const s = stateRef.current;
          const pane = s.panes[s.activePaneIndex];
          const msg = pane.openMessage || pane.messages[pane.selectedIndex];
          if (!msg) {
            dispatch({ type: "SET_STATUS", message: "No message selected" });
            return;
          }
          const token = getToken(pane.worker);
          const fromId =
            typeof msg.from === "string" ? msg.from : msg.from?.id || msg.fromId;
          await sendMessage(token, [fromId], `Re: ${msg.subject || ""}`, body, {
            threadId: msg.threadId,
            inReplyTo: msg.id,
          });
          dispatch({ type: "SET_STATUS", message: "Reply sent" });
          return;
        }

        dispatch({
          type: "SET_STATUS",
          message: `Unknown command: ${verb}`,
        });
      } catch (e: any) {
        dispatch({
          type: "SET_STATUS",
          message: `Error: ${e.message?.slice(0, 60)}`,
        });
      }
    },
    [exit, getToken, refreshPane]
  );

  // ── Message actions ──
  const handleMessageAction = useCallback(
    async (action: "archive" | "star" | "trash" | "reply" | "markread") => {
      const s = stateRef.current;
      const pane = s.panes[s.activePaneIndex];
      const msg = pane.openMessage || pane.messages[pane.selectedIndex];
      if (!msg) return;

      const token = getToken(pane.worker);

      try {
        if (action === "archive") {
          await archiveMessage(token, msg.id);
          dispatch({ type: "CLOSE_DETAIL" });
          dispatch({ type: "SET_STATUS", message: "Archived" });
          refreshPane(s.activePaneIndex);
        } else if (action === "star") {
          const isStarred = (msg.labelIds || []).includes("STARRED");
          await starMessage(token, msg.id, isStarred);
          dispatch({
            type: "SET_STATUS",
            message: isStarred ? "Unstarred" : "\u2605 Starred",
          });
          refreshPane(s.activePaneIndex);
        } else if (action === "trash") {
          await trashMessage(token, msg.id);
          dispatch({ type: "CLOSE_DETAIL" });
          dispatch({ type: "SET_STATUS", message: "Trashed" });
          refreshPane(s.activePaneIndex);
        } else if (action === "reply") {
          // Open detail if not already open, then enter reply mode
          if (!pane.openMessage) {
            try {
              const full = await fetchMessage(token, msg.id);
              dispatch({ type: "OPEN_MESSAGE", message: full || msg });
            } catch {
              dispatch({ type: "OPEN_MESSAGE", message: msg });
            }
          }
          dispatch({ type: "ENTER_REPLY" });
        } else if (action === "markread") {
          const isUnread = (msg.labelIds || []).includes("UNREAD");
          // Toggle read/unread using label modify
          const { bmsRequest } = await import("./bms.js");
          await bmsRequest(token, "POST", `/api/messages/${msg.id}/modify`, {
            addLabelIds: isUnread ? [] : ["UNREAD"],
            removeLabelIds: isUnread ? ["UNREAD"] : [],
          });
          dispatch({
            type: "SET_STATUS",
            message: isUnread ? "Marked read" : "Marked unread",
          });
          refreshPane(s.activePaneIndex);
        }
      } catch (e: any) {
        dispatch({
          type: "SET_STATUS",
          message: `Error: ${e.message?.slice(0, 60)}`,
        });
      }
    },
    [getToken, refreshPane]
  );

  // ── Send reply ──
  const sendReply = useCallback(async () => {
    const s = stateRef.current;
    const pane = s.panes[s.activePaneIndex];
    const msg = pane.openMessage || pane.messages[pane.selectedIndex];
    if (!msg || !s.replyInput.trim()) return;

    const token = getToken(pane.worker);
    const fromId =
      typeof msg.from === "string" ? msg.from : msg.from?.id || msg.fromId;

    try {
      await sendMessage(token, [fromId], `Re: ${msg.subject || ""}`, s.replyInput.trim(), {
        threadId: msg.threadId,
        inReplyTo: msg.id,
      });
      dispatch({ type: "EXIT_REPLY" });
      dispatch({ type: "SET_STATUS", message: "Reply sent" });
      refreshPane(s.activePaneIndex);
    } catch (e: any) {
      dispatch({
        type: "SET_STATUS",
        message: `Send error: ${e.message?.slice(0, 60)}`,
      });
    }
  }, [getToken, refreshPane]);

  // ── Open selected item ──
  const openSelected = useCallback(async () => {
    const s = stateRef.current;

    if (s.focusedPanel === "sidebar") {
      // Switch pane to selected worker
      const worker = s.workerList[s.sidebarIndex];
      if (!worker) return;
      dispatch({
        type: "SET_PANE_WORKER",
        paneIndex: s.activePaneIndex,
        worker: worker.name,
      });
      dispatch({ type: "FOCUS_PANE" });
      setTimeout(() => refreshPane(s.activePaneIndex), 50);
      return;
    }

    if (s.focusedPanel !== "pane") return;

    const pane = s.panes[s.activePaneIndex];

    // If detail is open, close it
    if (pane.openMessage || pane.openThread) {
      dispatch({ type: "CLOSE_DETAIL" });
      return;
    }

    // Open selected message or thread
    if (pane.tab === "inbox" || pane.tab === "sent") {
      const msg = pane.messages[pane.selectedIndex];
      if (!msg) return;
      try {
        const token = getToken(pane.worker);
        const full = await fetchMessage(token, msg.id);
        dispatch({ type: "OPEN_MESSAGE", message: full || msg });
      } catch {
        dispatch({ type: "OPEN_MESSAGE", message: msg });
      }
    } else if (pane.tab === "threads") {
      const thread = pane.threads[pane.selectedIndex];
      if (!thread) return;
      try {
        const token = getToken(pane.worker);
        const full = await fetchThread(token, thread.id);
        dispatch({ type: "OPEN_THREAD", thread: full || thread });
      } catch {
        dispatch({ type: "OPEN_THREAD", thread });
      }
    }
  }, [getToken, refreshPane]);

  // ── Keyboard Input ──
  useInput((input, key) => {
    const s = stateRef.current;

    // Help overlay
    if (s.showHelp) {
      if (key.escape || input === "?" || input === "q") {
        dispatch({ type: "TOGGLE_HELP" });
      }
      return;
    }

    // Reply mode — inline text input below message
    if (s.replyMode) {
      if (key.return) {
        sendReply();
        return;
      }
      if (key.escape) {
        dispatch({ type: "EXIT_REPLY" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "SET_REPLY_INPUT", input: s.replyInput.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "SET_REPLY_INPUT", input: s.replyInput + input });
      }
      return;
    }

    // Command mode
    if (s.commandMode) {
      if (key.return) {
        executeCommand(s.commandInput);
        return;
      }
      if (key.escape) {
        dispatch({ type: "EXIT_COMMAND" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({
          type: "SET_COMMAND_INPUT",
          input: s.commandInput.slice(0, -1),
        });
        return;
      }
      // Tab completion
      if (key.tab) {
        const cmds = ["vsplit", "hsplit", "close", "as", "send", "search", "reply", "quit"];
        const workerNames = s.workerList.map((w) => w.name);
        // Use the original base text when cycling
        const txt = s.tabCompletionBase || s.commandInput;
        const parts = txt.split(/\s+/);

        let completions: string[] = [];
        if (parts.length <= 1) {
          const prefix = parts[0] || "";
          completions = cmds
            .filter((c) => c.startsWith(prefix))
            .map((c) => c + " ");
        } else {
          const cmd = parts[0];
          const argPrefix = parts.slice(1).join(" ");
          const matches = workerNames.filter((w) => w.startsWith(argPrefix));
          if (matches.length === 0) {
            matches.push(...workerNames.filter((w) => w.includes(argPrefix)));
          }
          completions = matches.map((w) => cmd + " " + w);
        }
        if (completions.length > 0) {
          dispatch({ type: "TAB_COMPLETE", completions });
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({
          type: "SET_COMMAND_INPUT",
          input: s.commandInput + input,
        });
      }
      return;
    }

    // Ctrl-C to quit
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    // Global keys
    if (input === ":") {
      dispatch({ type: "ENTER_COMMAND" });
      return;
    }
    if (input === "?") {
      dispatch({ type: "TOGGLE_HELP" });
      return;
    }
    if (input === "q") {
      if (s.panes.length > 1) {
        dispatch({ type: "REMOVE_PANE", paneIndex: s.activePaneIndex });
      } else {
        exit();
      }
      return;
    }
    if (input === "R") {
      dispatch({ type: "SET_STATUS", message: "Refreshing..." });
      refreshAll();
      return;
    }
    if (key.tab) {
      dispatch({ type: "CYCLE_FOCUS" });
      return;
    }

    // Panel focus
    if (input === "h") {
      if (s.focusedPanel === "pane") {
        dispatch({ type: "FOCUS_SIDEBAR" });
      }
      return;
    }
    if (input === "l") {
      if (s.focusedPanel === "sidebar") {
        dispatch({ type: "FOCUS_PANE" });
      }
      return;
    }

    // Tab switching (1-4) when in pane
    if (s.focusedPanel === "pane") {
      const tabMap: Record<string, Tab> = {
        "1": "inbox",
        "2": "threads",
        "3": "fleet",
        "4": "sent",
      };
      if (tabMap[input]) {
        dispatch({
          type: "SET_PANE_TAB",
          paneIndex: s.activePaneIndex,
          tab: tabMap[input],
        });
        setTimeout(() => refreshPane(s.activePaneIndex), 50);
        return;
      }

      // Ctrl-n / Ctrl-p for tab cycling
      if (key.ctrl && input === "n") {
        const tabs: Tab[] = ["inbox", "threads", "fleet", "sent"];
        const pane = s.panes[s.activePaneIndex];
        const idx = tabs.indexOf(pane.tab);
        const nextTab = tabs[(idx + 1) % tabs.length];
        dispatch({
          type: "SET_PANE_TAB",
          paneIndex: s.activePaneIndex,
          tab: nextTab,
        });
        setTimeout(() => refreshPane(s.activePaneIndex), 50);
        return;
      }
      if (key.ctrl && input === "p") {
        const tabs: Tab[] = ["inbox", "threads", "fleet", "sent"];
        const pane = s.panes[s.activePaneIndex];
        const idx = tabs.indexOf(pane.tab);
        const prevTab = tabs[(idx - 1 + tabs.length) % tabs.length];
        dispatch({
          type: "SET_PANE_TAB",
          paneIndex: s.activePaneIndex,
          tab: prevTab,
        });
        setTimeout(() => refreshPane(s.activePaneIndex), 50);
        return;
      }
    }

    // Vim navigation
    if (input === "j" || key.downArrow) {
      if (s.focusedPanel === "sidebar") {
        dispatch({ type: "SIDEBAR_DOWN" });
      } else {
        dispatch({ type: "CURSOR_DOWN" });
        // Auto-open next message if detail is currently visible
        const pane = s.panes[s.activePaneIndex];
        if (pane && (pane.openMessage || pane.openThread)) {
          const nextIdx = Math.min(pane.selectedIndex + 1, (pane.tab === "inbox" || pane.tab === "sent" ? pane.messages.length : pane.threads.length) - 1);
          if (pane.tab === "inbox" || pane.tab === "sent") {
            const msg = pane.messages[nextIdx];
            if (msg) {
              const token = getToken(pane.worker);
              fetchMessage(token, msg.id).then((full) => {
                dispatch({ type: "OPEN_MESSAGE", message: full || msg });
              }).catch(() => dispatch({ type: "OPEN_MESSAGE", message: msg }));
            }
          } else if (pane.tab === "threads") {
            const thread = pane.threads[nextIdx];
            if (thread) {
              const token = getToken(pane.worker);
              fetchThread(token, thread.id).then((full) => {
                dispatch({ type: "OPEN_THREAD", thread: full || thread });
              }).catch(() => dispatch({ type: "OPEN_THREAD", thread }));
            }
          }
        }
      }
      return;
    }
    if (input === "k" || key.upArrow) {
      if (s.focusedPanel === "sidebar") {
        dispatch({ type: "SIDEBAR_UP" });
      } else {
        dispatch({ type: "CURSOR_UP" });
        // Auto-open prev message if detail is currently visible
        const pane = s.panes[s.activePaneIndex];
        if (pane && (pane.openMessage || pane.openThread)) {
          const prevIdx = Math.max(pane.selectedIndex - 1, 0);
          if (pane.tab === "inbox" || pane.tab === "sent") {
            const msg = pane.messages[prevIdx];
            if (msg) {
              const token = getToken(pane.worker);
              fetchMessage(token, msg.id).then((full) => {
                dispatch({ type: "OPEN_MESSAGE", message: full || msg });
              }).catch(() => dispatch({ type: "OPEN_MESSAGE", message: msg }));
            }
          } else if (pane.tab === "threads") {
            const thread = pane.threads[prevIdx];
            if (thread) {
              const token = getToken(pane.worker);
              fetchThread(token, thread.id).then((full) => {
                dispatch({ type: "OPEN_THREAD", thread: full || thread });
              }).catch(() => dispatch({ type: "OPEN_THREAD", thread }));
            }
          }
        }
      }
      return;
    }

    // gg / G
    if (input === "g") {
      if (s.pendingG) {
        dispatch({ type: "GOTO_TOP" });
      } else {
        dispatch({ type: "SET_PENDING_G", pending: true });
      }
      return;
    }
    if (input === "G") {
      dispatch({ type: "GOTO_BOTTOM" });
      return;
    }

    // Page down/up
    if (key.ctrl && input === "d") {
      dispatch({ type: "PAGE_DOWN", pageSize: Math.floor(rows / 2) });
      return;
    }
    if (key.ctrl && input === "u") {
      dispatch({ type: "PAGE_UP", pageSize: Math.floor(rows / 2) });
      return;
    }

    // Enter — open item
    if (key.return) {
      openSelected();
      return;
    }

    // Escape — close detail
    if (key.escape) {
      dispatch({ type: "CLOSE_DETAIL" });
      return;
    }

    // Message actions (only when in pane focus)
    if (s.focusedPanel === "pane") {
      // Gmail-style: e or a for archive
      if (input === "e" || input === "a") {
        handleMessageAction("archive");
        return;
      }
      if (input === "s") {
        handleMessageAction("star");
        return;
      }
      // Gmail-style: # or d for trash
      if (input === "d" || input === "#") {
        handleMessageAction("trash");
        return;
      }
      if (input === "r") {
        handleMessageAction("reply");
        return;
      }
      // u — go back to list (Gmail: return to inbox view)
      if (input === "u") {
        dispatch({ type: "CLOSE_DETAIL" });
        dispatch({ type: "EXIT_REPLY" });
        return;
      }
      // I — mark read/unread toggle
      if (input === "I") {
        handleMessageAction("markread");
        return;
      }

      // / for search
      if (input === "/") {
        dispatch({ type: "ENTER_COMMAND" });
        dispatch({ type: "SET_COMMAND_INPUT", input: "search " });
        return;
      }
    }

    // Clear pending g on any other key
    if (s.pendingG) {
      dispatch({ type: "SET_PENDING_G", pending: false });
    }
  });

  // ── Layout ──
  const mainHeight = rows - 1; // -1 for command bar

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <Box flexDirection="column" height={rows} width={cols}>
        {state.showHelp ? (
          <HelpOverlay rows={rows} cols={cols} />
        ) : (
          <>
            <Box flexDirection="row" height={mainHeight}>
              <Sidebar width={SIDEBAR_WIDTH} />
              <MainArea height={mainHeight} width={cols - SIDEBAR_WIDTH} />
            </Box>
            <CommandBar />
          </>
        )}
      </Box>
    </AppContext.Provider>
  );
}
