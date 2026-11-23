import { sha256 } from "@noble/hashes/sha2.js";
import {
  RPC_JSON_FILE_MAX_BYTES,
  RPC_JSON_FILE_MIME,
  rpcJsonFileName,
} from "@openbot/contracts/team-protocol/rpc-json-files-v1";
import {
  decodeTeamProtocolV2FileChunk,
  decodeTeamProtocolV2FileControlFrame,
  encodeTeamProtocolV2Frame,
} from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { FileTransferError, fileTransferError, MOBILE_ATTACHMENT_BYTES } from "./file-upload";

function transferFailure(message: string): FileTransferError {
  return new FileTransferError({ message });
}

const SAVED_PART_BYTES = 960 * 1024;

export interface DownloadTarget {
  ref: string;
  write: (base64: string, append: boolean) => Effect.Effect<void, FileTransferError>;
}

interface Download {
  name: string;
  mimeType: string;
  size: number;
  received: number;
  hash: ReturnType<typeof sha256.create>;
  base64: string[];
  buffered: number;
  carry: Uint8Array;
  target: DownloadTarget | undefined;
  saved: boolean;
  digest: string;
  complete: boolean;
  allowed: boolean;
  jsonRequest?: string;
  timer: ReturnType<typeof setTimeout>;
}

type ReceivedFile =
  | { name: string; mimeType: string; base64: string }
  | { name: string; mimeType: string; base64: string; file: { ref: string; size: number } };

function receivedFile(entry: Download): ReceivedFile {
  if (!entry.target) return { name: entry.name, mimeType: entry.mimeType, base64: entry.base64.join("") };
  return { name: entry.name, mimeType: entry.mimeType, base64: "", file: { ref: entry.target.ref, size: entry.size } };
}

interface DownloadAllowance {
  maxBytes: number;
  mimeType: string | undefined;
  target: DownloadTarget | undefined;
  taken: boolean;
}

interface DownloadWatch {
  size: number;
  onProgress: (received: number, size: number) => void;
  transferId: string | null;
}

export function createRemoteFileReceiver<E, R>(send: (data: string) => Effect.Effect<void, E, R>) {
  const downloads = new Map<string, Download>();
  const allowances = new Set<DownloadAllowance>();
  const jsonRequests = new Map<string, { progress: () => void; failed: (error: Error) => void }>();
  const waiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const ended = new Map<string, string>();
  const watches = new Set<DownloadWatch>();
  function report(id: string, received: number, size: number) {
    for (const watch of watches) if (watch.transferId === id) watch.onProgress(received, size);
  }
  function remove(id: string) {
    const entry = downloads.get(id);
    if (entry) clearTimeout(entry.timer);
    downloads.delete(id);
  }
  function fail(id: string, message: string) {
    const entry = downloads.get(id);
    if (entry?.jsonRequest) jsonRequests.get(entry.jsonRequest)?.failed(new Error(message));
    remove(id);
    const waiter = waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(id);
      waiter.reject(new Error(message));
      return;
    }
    // A JSON request hears of the failure above and never takes the file.
    if (entry?.jsonRequest) return;
    ended.set(id, message);
    for (const old of ended.keys()) {
      if (ended.size <= 32) break;
      ended.delete(old);
    }
  }
  function expire(id: string) {
    fail(id, sourceText("error.remote.downloadTimeout"));
  }
  function touch(id: string) {
    const entry = downloads.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => expire(id), 60_000);
      if (entry.jsonRequest) jsonRequests.get(entry.jsonRequest)?.progress();
    }
    const waiter = waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => expire(id), 60_000);
    }
  }
  const sendFrame = (data: string) => send(data).pipe(Effect.mapError(fileTransferError));
  const save = Effect.fn("RemoteFileReceiver.save")(function* (id: string, entry: Download) {
    if (!entry.target) return true;
    const base64 = entry.base64.join("");
    entry.base64 = [];
    entry.buffered = 0;
    const saved = yield* entry.target.write(base64, entry.saved).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (saved) {
      entry.saved = true;
      return true;
    }
    fail(id, sourceText("error.remote.downloadIncompleteRetry"));
    yield* sendFrame(
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "file-cancel",
        transferId: id,
        reason: "The device could not save the attachment.",
      }),
    );
    return false;
  });
  const take = Effect.fn("RemoteFileReceiver.take")(function* (id: string) {
    const reason = ended.get(id);
    if (reason !== undefined) {
      ended.delete(id);
      return yield* transferFailure(reason);
    }
    if (!downloads.get(id)?.complete) {
      if (waiters.has(id) || waiters.size >= 10)
        return yield* transferFailure(sourceText("error.remote.tooManyDownloads"));
      yield* Effect.callback<void, FileTransferError>((resume) => {
        const timer = setTimeout(() => expire(id), 60_000);
        const waiter = {
          resolve: () => resume(Effect.void),
          reject: (error: Error) => resume(Effect.fail(fileTransferError(error))),
          timer,
        };
        waiters.set(id, waiter);
        return Effect.sync(() => {
          clearTimeout(timer);
          if (waiters.get(id) === waiter) waiters.delete(id);
        });
      });
    }
    const entry = downloads.get(id);
    if (!entry?.complete) return yield* transferFailure(sourceText("error.remote.downloadIncompleteRetry"));
    remove(id);
    return receivedFile(entry);
  });
  const takeBytes = Effect.fn("RemoteFileReceiver.takeBytes")(function* (id: string) {
    const file = yield* take(id);
    return { name: file.name, mimeType: file.mimeType, bytes: base64ToBytes(file.base64) };
  });
  const cancelJson = Effect.fn("RemoteFileReceiver.cancelJson")(function* (requestId: string) {
    const name = rpcJsonFileName(requestId);
    jsonRequests.delete(name);
    for (const [id, entry] of downloads) {
      if (entry.jsonRequest !== name) continue;
      fail(id, sourceText("error.remote.downloadIncompleteRetry"));
      if (!entry.complete)
        yield* sendFrame(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-cancel",
            transferId: id,
            reason: "The JSON response request ended.",
          }),
        );
    }
  });
  const receive = Effect.fn("RemoteFileReceiver.receive")(function* (data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      const chunk = yield* Effect.try({ try: () => decodeTeamProtocolV2FileChunk(data), catch: fileTransferError });
      const entry = downloads.get(chunk.transferId);
      if (!entry) {
        yield* sendFrame(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-cancel",
            transferId: chunk.transferId,
            reason: "The attachment download is no longer active.",
          }),
        );
        return true;
      }
      if (entry.complete || chunk.offset !== entry.received || chunk.offset + chunk.bytes.length > entry.size)
        return yield* transferFailure("The host sent an invalid attachment chunk.");
      entry.received += chunk.bytes.length;
      entry.hash.update(chunk.bytes);
      let pending = chunk.bytes;
      if (entry.carry.length > 0) {
        pending = new Uint8Array(entry.carry.length + chunk.bytes.length);
        pending.set(entry.carry);
        pending.set(chunk.bytes, entry.carry.length);
      }
      const whole = pending.length - (pending.length % 3);
      entry.base64.push(bytesToBase64(pending.subarray(0, whole)));
      entry.buffered += whole;
      entry.carry = pending.slice(whole);
      if (entry.buffered >= SAVED_PART_BYTES && !(yield* save(chunk.transferId, entry))) return true;
      if (chunk.bytes.length > 0) touch(chunk.transferId);
      report(chunk.transferId, entry.received, entry.size);
      yield* sendFrame(
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "file-ack",
          transferId: chunk.transferId,
          receivedThrough: entry.received,
        }),
      );
      return true;
    }
    const frame = yield* Effect.try({
      try: () => decodeTeamProtocolV2FileControlFrame(data),
      catch: fileTransferError,
    });
    if (frame.type === "file-open") {
      if (downloads.has(frame.transferId)) return yield* transferFailure("The host repeated an attachment transfer.");
      const total = [...downloads.values()]
        .filter((entry) => !entry.allowed)
        .reduce((sum, entry) => sum + entry.size, 0);
      const json = frame.mimeType === RPC_JSON_FILE_MIME;
      const jsonRequest = json ? jsonRequests.get(frame.name) : undefined;
      const jsonTotal = [...downloads.values()]
        .filter((entry) => entry.jsonRequest !== undefined)
        .reduce((sum, entry) => sum + entry.size, 0);
      const open = [...allowances].filter(
        (entry) => !entry.taken && (entry.mimeType === undefined || entry.mimeType === frame.mimeType),
      );
      const targeted = open.filter((entry) => entry.target && frame.size === entry.maxBytes);
      const onlyTarget = targeted.length === 1 ? targeted[0] : undefined;
      const allowance =
        !json && frame.size > MOBILE_ATTACHMENT_BYTES
          ? (onlyTarget ??
            open.find((entry) => !entry.target && frame.size <= entry.maxBytes) ??
            open.find((entry) => frame.size <= entry.maxBytes))
          : undefined;
      const invalidJson =
        json &&
        (!jsonRequest ||
          frame.size < 1 ||
          frame.size > RPC_JSON_FILE_MAX_BYTES ||
          jsonTotal + frame.size > RPC_JSON_FILE_MAX_BYTES ||
          [...downloads.values()].some((entry) => entry.jsonRequest === frame.name));
      if (allowance) allowance.taken = true;
      if (
        (json && downloads.size >= 10) ||
        invalidJson ||
        (!json &&
          !allowance &&
          (frame.size > MOBILE_ATTACHMENT_BYTES ||
            total + frame.size > MOBILE_ATTACHMENT_BYTES * 2 ||
            downloads.size >= 10))
      ) {
        if (jsonRequest) jsonRequest.failed(new Error(sourceText("error.remote.responseTooLarge")));
        yield* sendFrame(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-cancel",
            transferId: frame.transferId,
            reason: json
              ? sourceText("error.remote.responseTooLarge")
              : "Attachments must be 10 MB or smaller. Download fewer files at once.",
          }),
        );
        fail(
          frame.transferId,
          sourceText(
            frame.size <= MOBILE_ATTACHMENT_BYTES
              ? "error.remote.tooManyDownloads"
              : open.length > 0
                ? "error.remote.fileTooLarge"
                : "error.remote.attachmentTooLarge",
          ),
        );
        return true;
      }
      downloads.set(frame.transferId, {
        name: frame.name,
        mimeType: frame.mimeType,
        size: frame.size,
        received: 0,
        hash: sha256.create(),
        base64: [],
        buffered: 0,
        carry: new Uint8Array(0),
        target: allowance !== undefined && allowance === onlyTarget ? allowance.target : undefined,
        saved: false,
        digest: frame.sha256,
        complete: false,
        allowed: allowance !== undefined || json,
        ...(json ? { jsonRequest: frame.name } : {}),
        timer: setTimeout(() => expire(frame.transferId), 60_000),
      });
      touch(frame.transferId);
      const watch = [...watches].find((item) => item.transferId === null && item.size === frame.size);
      if (watch) {
        watch.transferId = frame.transferId;
        watch.onProgress(0, frame.size);
      }
      yield* sendFrame(
        encodeTeamProtocolV2Frame({ version: 2, type: "file-ack", transferId: frame.transferId, receivedThrough: 0 }),
      );
      return true;
    }
    if (frame.type === "file-complete") {
      const entry = downloads.get(frame.transferId);
      if (!entry) return true;
      if (entry.received !== entry.size) {
        fail(frame.transferId, sourceText("error.remote.downloadIncomplete"));
        return yield* transferFailure(sourceText("error.remote.downloadIncomplete"));
      }
      const digest = Array.from(entry.hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== entry.digest) {
        fail(frame.transferId, sourceText("error.remote.downloadDamaged"));
        return yield* transferFailure(sourceText("error.remote.downloadDamaged"));
      }
      if (entry.carry.length > 0) entry.base64.push(bytesToBase64(entry.carry));
      entry.carry = new Uint8Array(0);
      if (!(yield* save(frame.transferId, entry))) return true;
      entry.complete = true;
      touch(frame.transferId);
      const waiter = waiters.get(frame.transferId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(frame.transferId);
        waiter.resolve();
      }
      return true;
    }
    if (frame.type === "file-cancel" && (downloads.has(frame.transferId) || waiters.has(frame.transferId))) {
      const retry = downloads.get(frame.transferId)?.jsonRequest !== undefined;
      fail(
        frame.transferId,
        sourceText(retry ? "error.remote.downloadIncompleteRetry" : "error.remote.downloadStopped"),
      );
      return true;
    }
    return false;
  });
  return {
    allow(maxBytes: number, mimeType?: string, target?: DownloadTarget) {
      const allowance: DownloadAllowance = { maxBytes, mimeType, target, taken: false };
      allowances.add(allowance);
      return () => {
        allowances.delete(allowance);
      };
    },
    expectJson(requestId: string, progress: () => void, failed: (error: Error) => void) {
      const name = rpcJsonFileName(requestId);
      if (jsonRequests.has(name)) throw new Error("Repeated JSON response request.");
      jsonRequests.set(name, { progress, failed });
    },
    cancelJson,
    watch(size: number, onProgress: (received: number, size: number) => void) {
      const watch: DownloadWatch = { size, onProgress, transferId: null };
      watches.add(watch);
      return () => {
        watches.delete(watch);
      };
    },
    clear() {
      jsonRequests.clear();
      for (const id of downloads.keys()) remove(id);
      ended.clear();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(sourceText("error.remote.attachmentConnectionClosed")));
      }
      waiters.clear();
    },
    take,
    takeBytes,
    receive,
  };
}
