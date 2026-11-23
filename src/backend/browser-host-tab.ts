import type { BrowserEnvironment, BrowserPreview, BrowserTab } from "@openbot/contracts/ipc";
import type { BrowserViewContextMenu } from "@openbot/contracts/team-protocol/browser-view-v1";
import type { Deferred, Effect, Scope } from "effect";
import { BrowserWindow, type Session, type WebContents, type WebContentsView, webContents } from "electron";
import type { BrowserCdpEngine } from "./browser-cdp";
import type { BrowserCdpBridge } from "./browser-cdp-bridge";
import type { FrameBox } from "./browser-challenge";
import type { BrowserDiagnostics } from "./browser-diagnostics";
import type { BrowserOperationError } from "./browser-effects";
import { type BrowserTabSession, isPersistableBrowserUrl } from "./browser-state";

export interface BrowserPreviewPage {
  url: string;
  document: number;
  generation: number;
}

export interface BrowserHostTab {
  id: string;
  view: WebContentsView;
  contents: WebContents;
  requestedUrl: string;
  openerTabId?: string;
  hasSharedBrowsingContext?: boolean;
  secretDocument?: boolean;
  secretShown?: boolean;
  filledCard?: boolean;
  /**
   * The origin and time of the last saved password that the Vault entered in this tab. Only the step
   * right after it, on the same origin and within `SPLIT_CODE_AFTER_PASSWORD_MS`, can fill a split
   * authenticator code group from the Vault, and only once: the submit of that code deletes it, so a
   * payment step-up later in the session goes to the card. A main-frame navigation to another origin
   * deletes it; an idle unload keeps it; it closes with the tab.
   */
  vaultPasswordFill?: { origin: string; at: number } | undefined;
  /** A local CDP client registered supplied credentials for this document. Images stay protected. */
  sourceSecretDocument?: boolean;
  /**
   * The origins whose agent code can run in the current document: the agent ran `evaluate` in it,
   * or a scripted page of a connected tab could reach it. While it is set, no page of the origin in
   * the session fills. A main-frame navigation or an idle unload ends the document and clears this.
   */
  scriptedOrigins?: Set<string>;
  workerExposedOrigins?: Set<string>;
  privateSession?: Session;
  tabSession?: BrowserTabSession;
  popup: boolean;
  popupFailure?: BrowserTab["popupFailure"];
  closing?: boolean;
  externalCdp?: BrowserCdpBridge;
  ownerThreadId: string | null;
  ownerAgentId: string | null;
  sharedThreadIds?: Set<string>;
  revision: number;
  operations?: number;
  image?: { operation: number; url: string; taken: number };
  queue: Deferred.Deferred<void>;
  scope: Scope.Closeable;
  pendingOperations: number;
  /** True while `open` waits for the tab's first page. That wait is not on `queue`, and it is a use of the tab. */
  opening?: boolean;
  /** How often the page renderer crashed. A `run_script` stops when this changes. */
  crashes?: number;
  endingSilentPage?: boolean;
  documents: number;
  challengeWait?: { document: number; waitedMs: number };
  /**
   * The document whose bot check offered its checkbox for one click, and the widget box of the last
   * offer. Each read offers the click again until an agent click lands in the widget (`clicked`). The
   * first read after that click waits once for the check to pass (`waited`); later reads of that
   * document offer no click.
   */
  challengeClick?: { document: number; widget: FrameBox; clicked: boolean; waited: boolean };
  /** The origin of the page whose last read found a bot check. */
  checkOrigin?: string;
  checkAfterTakeover?: string;
  siteRecall?: { turnId: string; host: string };
  preview?: (BrowserPreviewPage & { frame: BrowserPreview }) | undefined;
  previewCapture?:
    | (BrowserPreviewPage & { frame: Deferred.Deferred<BrowserPreview, BrowserOperationError> })
    | undefined;
  pendingRestore?: (() => Effect.Effect<void, BrowserOperationError>) | undefined;
  sleeping?: { title: string; preview: BrowserPreview | null } | undefined;
  idleUnloadNoted?: Set<string>;
  lastUsedAt: number;
  lastToolChat?: { threadId: string; at: number } | undefined;
  focusOnVisible: boolean;
  focusOnCommit?: boolean | undefined;
  focusedAtPageClose?: boolean | undefined;
  environment: BrowserEnvironment;
  engine: BrowserCdpEngine;
  diagnostics: BrowserDiagnostics;
  recording: boolean;
  captureGeneration: number;
  loadGeneration: number;
  viewInvalidations: Set<() => void>;
  viewContextMenu: { deliver: (menu: BrowserViewContextMenu) => void; until: number } | null;
  visitedHost?: string | undefined;
  secret?: { origin: string; submitted: boolean; replaced: boolean; running: boolean } | undefined;
}

export type KeepQueueBlocked = (work: Effect.Effect<unknown, BrowserOperationError>) => void;

export function restoreWebContentsFocus(previous: WebContents | null, controlled: WebContents): void {
  const current = webContents.getFocusedWebContents();
  if (current && current !== controlled) return;
  if (previous && !previous.isDestroyed()) {
    const window = BrowserWindow.fromWebContents(previous);
    if (window && !window.isDestroyed()) window.focus();
    previous.focus();
  }
}

export function hasHistoryEntry(contents: WebContents, offset: -1 | 1): boolean {
  const history = contents.navigationHistory;
  return history.canGoToOffset(offset) && Boolean(history.getEntryAtIndex(history.getActiveIndex() + offset)?.url);
}

export function toPublicTab(tab: BrowserHostTab): BrowserTab {
  const environment =
    tab.environment.viewport.mode === "fill"
      ? {
          ...tab.environment,
          viewport: {
            ...tab.environment.viewport,
            width: tab.view.getBounds().width,
            height: tab.view.getBounds().height,
          },
        }
      : tab.environment;
  return {
    id: tab.id,
    title: tab.secret
      ? "Secure authentication"
      : restoredTabTitle(tab) || tab.engine.scrubText(tab.contents.getTitle()) || "New tab",
    url: tab.secret?.origin ?? currentTabUrl(tab),
    loading: tab.contents.isLoading(),
    ownerThreadId: tab.ownerThreadId,
    ownerAgentId: tab.ownerAgentId,
    environment,
    recording: tab.recording,
    diagnosticErrorCount: tab.diagnostics.errorCount,
    canGoBack: hasHistoryEntry(tab.contents, -1),
    canGoForward: hasHistoryEntry(tab.contents, 1),
    ...(tab.openerTabId ? { openerTabId: tab.openerTabId } : {}),
    ...(tab.popupFailure ? { popupFailure: tab.popupFailure } : {}),
  };
}

function restoredTabTitle(tab: BrowserHostTab): string | null {
  if (!tab.pendingRestore) return null;
  if (tab.sleeping?.title) return tab.sleeping.title;
  try {
    return new URL(tab.requestedUrl).hostname || null;
  } catch {
    return null;
  }
}

export function currentTabUrl(tab: BrowserHostTab): string {
  const currentUrl = tab.contents.getURL();
  return isPersistableBrowserUrl(currentUrl) ? currentUrl : tab.requestedUrl;
}
