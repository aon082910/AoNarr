import type { ClientLimits, PrioritySettings, ThrottleWindow } from "./settings.js";

/**
 * Throttlearr's rules, as pure functions: no database, no clock, no client. `grab()` asks `admit` whether one
 * grab may go to its client now; the release worker asks `selectReleases` which of the held grabs may go.
 * Both use the same checks, so a grab is held for exactly the reasons it is later released.
 */

export type PriorityClass = "movie" | "recentTv" | "backlog";

/** Aired more than this long ago: backlog. */
export const BACKLOG_AFTER_DAYS = 365;

/** What a client has to do right now, and what a pass has already added to it. */
export interface ClientState {
  active: number;
  /** Bytes the client still has to download; null when neither it nor AoNarr knows. */
  bytesLeft: number | null;
  /** Adds to the client in the last hour. */
  addsLastHour: number;
  /** Free bytes where the downloads land; null when unknown (never blocks). */
  freeBytes: number | null;
  /** Jobs per title (media item id) the client holds. */
  titleActive: Map<number, number>;
}

export interface Candidate {
  id: number;
  mediaItemId: number;
  size: number | null;
  priorityClass: PriorityClass;
}

export type BlockKind = "window" | "night" | "count" | "bytes" | "adds" | "disk" | "title";

export interface Admission {
  ok: boolean;
  kind?: BlockKind;
  reason?: string;
}

const MINUTES = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Whether `now` (the server's local time) is inside the window. A window whose end is before its start runs past
 * midnight into the next day; one whose end equals its start is the whole day. `days` name the day it starts on. */
export function inWindow(w: ThrottleWindow, now: Date): boolean {
  const day = now.getDay();
  const prev = (day + 6) % 7;
  const m = now.getHours() * 60 + now.getMinutes();
  const from = MINUTES(w.from);
  const to = MINUTES(w.to);
  if (from === to) return w.days.includes(day);
  if (from < to) return w.days.includes(day) && m >= from && m < to;
  return (w.days.includes(day) && m >= from) || (w.days.includes(prev) && m < to);
}

/** No windows: always. */
export function inAnyWindow(windows: ThrottleWindow[], now: Date): boolean {
  return windows.length === 0 || windows.some((w) => inWindow(w, now));
}

/** Whether `now` is in the night "from"-"to" (every day). */
export function isNight(p: Pick<PrioritySettings, "nightFrom" | "nightTo">, now: Date): boolean {
  return inWindow({ days: [0, 1, 2, 3, 4, 5, 6], from: p.nightFrom, to: p.nightTo }, now);
}

/** Movies first, then recent episodes, then the backlog; music and books are backlog. */
export function classifyGrab(input: { type: string; episodeId: number | null; seasonNumber: number | null; airDate: string | null; now?: Date }): PriorityClass {
  if (input.type === "movie") return "movie";
  if (input.episodeId != null || input.seasonNumber != null) {
    const at = input.airDate ? new Date(input.airDate).getTime() : NaN;
    const now = (input.now ?? new Date()).getTime();
    return Number.isFinite(at) && now - at > BACKLOG_AFTER_DAYS * 86_400_000 ? "backlog" : "recentTv";
  }
  return "backlog";
}

export function priorityFor(cls: PriorityClass, p: PrioritySettings): number {
  return cls === "movie" ? p.movies : cls === "recentTv" ? p.recentTv : p.backlog;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB`;

export interface AdmitInput {
  clientName: string;
  limits: ClientLimits;
  state: ClientState;
  candidate: Pick<Candidate, "mediaItemId" | "size" | "priorityClass">;
  priority: PrioritySettings;
  perTitleLimit: number | null;
  now: Date;
}

/** May this one grab go to its client now? The first rule that says no is the reason. */
export function admit(input: AdmitInput): Admission {
  const { clientName, limits, state, candidate, priority, perTitleLimit, now } = input;
  const size = candidate.size != null && candidate.size > 0 ? candidate.size : 0;

  if (!inAnyWindow(limits.windows, now)) {
    return { ok: false, kind: "window", reason: `Outside ${clientName}'s hours` };
  }
  if (priority.backlogOnlyAtNight && candidate.priorityClass === "backlog" && !isNight(priority, now)) {
    return { ok: false, kind: "night", reason: `Old episodes wait for the night (${priority.nightFrom}-${priority.nightTo})` };
  }
  if (limits.maxActive !== null && state.active >= limits.maxActive) {
    return { ok: false, kind: "count", reason: `${clientName} has ${state.active} of ${limits.maxActive} jobs` };
  }
  if (limits.maxActiveBytes !== null && state.active > 0 && (state.bytesLeft ?? 0) + size > limits.maxActiveBytes) {
    // An idle client takes one job whatever its size, or a job over the limit would wait for ever.
    return { ok: false, kind: "bytes", reason: `${clientName} has ${gb(state.bytesLeft ?? 0)} left of ${gb(limits.maxActiveBytes)}` };
  }
  if (limits.addsPerHour !== null && state.addsLastHour >= limits.addsPerHour) {
    return { ok: false, kind: "adds", reason: `${clientName} took ${state.addsLastHour} of ${limits.addsPerHour} adds this hour` };
  }
  if (limits.minFreeBytes !== null && state.freeBytes !== null && state.freeBytes - (state.bytesLeft ?? 0) - size < limits.minFreeBytes) {
    return { ok: false, kind: "disk", reason: `Free disk would drop under ${gb(limits.minFreeBytes)}` };
  }
  if (perTitleLimit !== null && (state.titleActive.get(candidate.mediaItemId) ?? 0) >= perTitleLimit) {
    return { ok: false, kind: "title", reason: `${perTitleLimit} jobs of this title are already running` };
  }
  return { ok: true };
}

/** The state after one more job has been sent. */
export function afterSend(state: ClientState, candidate: Pick<Candidate, "mediaItemId" | "size">): ClientState {
  const titleActive = new Map(state.titleActive);
  titleActive.set(candidate.mediaItemId, (titleActive.get(candidate.mediaItemId) ?? 0) + 1);
  const size = candidate.size != null && candidate.size > 0 ? candidate.size : 0;
  return {
    ...state,
    active: state.active + 1,
    bytesLeft: (state.bytesLeft ?? 0) + size,
    addsLastHour: state.addsLastHour + 1,
    titleActive,
  };
}

export interface Selection {
  selected: Candidate[];
  /** Why the head of the queue is still waiting (the first rule that stopped the pass), or null when all were chosen. */
  blockedBy: Admission | null;
}

/**
 * Walks the held grabs in release order (the caller sorts them) and picks the ones that may go now. A rule about the
 * client as a whole (hours, job count, bytes, adds, disk) ends the pass: later grabs would wait for the same reason,
 * and skipping a big one for a small one would starve it. A rule about the grab (its title already has its share, an old
 * episode before night) only skips that grab.
 */
export function selectReleases(
  candidates: Candidate[],
  args: { clientName: string; limits: ClientLimits; state: ClientState; priority: PrioritySettings; perTitleLimit: number | null; now: Date }
): Selection {
  const selected: Candidate[] = [];
  let state = args.state;
  let blockedBy: Admission | null = null;
  for (const c of candidates) {
    const verdict = admit({ ...args, state, candidate: c });
    if (verdict.ok) {
      selected.push(c);
      state = afterSend(state, c);
      continue;
    }
    blockedBy ??= verdict;
    if (verdict.kind !== "title" && verdict.kind !== "night") break;
  }
  return { selected, blockedBy };
}
