'use strict';

// ---------------------------------------------------------------------------
// #1136 — stateful VT observation (contract pf1136ah-r2 §4-§9)
// ---------------------------------------------------------------------------
//
// WHAT THIS IS. `GET /api/sessions/:id/screen` joins `session.outputRing`, strips ANSI
// (`src/screen-ansi.js`) and returns the tail. `outputRing` is an append-only log and the
// stripper deletes CUP/ED/EL finals and `\r`, so that endpoint returns the tail of ACCUMULATED
// HISTORY and never a grid — a property of the endpoint at any ring size, on any terminal.
// This module keeps a real VT grid alongside the ring, fed from the same single choke point,
// and answers a separate observation-only read.
//
// WHAT IT IS NOT. It is not a control plane, not a registry, not a sweeper, not an authority.
// A complete grid proves WHAT IS ON THE SCREEN — never who put it there, never what the CLI is
// waiting for, never that a turn finished. Nothing here authorizes an action.
//
// UNTRUSTED-TEXT INVARIANTS (contract §9, gate G-REPLY). Terminal output is attacker-influenced
// text. This module therefore NEVER:
//   * subscribes `onData` / `onBinary` / `onTitleChange` — so no DSR/DA/CPR/OSC answer, OSC 52
//     clipboard action, OSC 8 link action or title write can reach the host, the PTY or a log;
//   * calls `Terminal.input()`;
//   * sets `windowOptions` (xterm's own doc: "All features are disabled by default for security
//     reasons" — it stays that way);
//   * puts frame TEXT into a log line, a command or an approval record. Counts and field values
//     only. `console` is not used anywhere in this file, deliberately.
//
// UNIT. Every counter here is the UTF-16 code unit of the JS string as received —
// `String.prototype.length` — which is exactly what `daemon.js` (`outputRingTotalBytes`) and
// `cli.js` (`ptyBytesRead`, `preConnectChars`) already count. `@xterm/headless`'s own doc says
// "string data as UTF-16", so feeding it the same JS strings makes VT input units and daemon
// counters the same unit BY CONSTRUCTION. The only field named in bytes is `snapshot_bytes`,
// which is UTF-8 bytes of the serialized rows and is a BOUND, never an offset.
//
// PROPOSED API. `buffer` is marked (EXPERIMENTAL) in the typings and requires
// `allowProposedApi: true`. The dependency is therefore pinned to an exact version; gate G-API
// must be re-run on every upgrade. This carries no upstream stability guarantee.
//
// This file is self-contained and unit-testable without the daemon, exactly as
// `src/screen-ansi.js` is. Nothing in it reaches out to a session store, a socket or the disk.

// ---------------------------------------------------------------------------
// Bounds — explicit, conservative, documented constants (contract §8, correction 6)
// ---------------------------------------------------------------------------

const VT_MIN_DIMENSION = 1;
const VT_MAX_DIMENSION = 1000;

// Current grid only. xterm's default is 1000 lines of scrollback; a scrollback buffer is exactly
// the accumulated-history mistake this module exists to stop repeating.
const VT_SCROLLBACK = 0;

// Units allowed to sit in the op queue awaiting application. On breach the module stops
// accepting and counts the loss — it never grows without limit and never pretends the loss
// did not happen.
const VT_QUEUE_MAX_UNITS = 1048576;
// Correction 2: the queued OPERATION COUNT is bounded too, not only the queued string units.
// A flood of empty or one-unit frames must cost a fixed amount of memory.
const VT_QUEUE_MAX_OPS = 4096;

// Largest single string handed to the parser in one `write()`. Correction 6: bound the parser
// INPUT, not only the retained state.
const VT_MAX_WRITE_CHUNK_UNITS = 65536;

// A cell is not a character: `IBufferCell.getChars()` returns "the character(s) within the
// cell", so a combining sequence or ZWJ run is ONE cell and MANY code units. `rows x cols`
// therefore bounds CELLS and cannot bound bytes. These two do.
const VT_MAX_ROW_CHARS_PER_COL = 8;
const VT_MAX_SNAPSHOT_BYTES = 262144;

// Correction 6 again: snapshot truncation alone does not bound an xterm cell growing across
// many combining-character writes, because the growth is in the GRID, not in the serialization.
// After this many applied units, walk the grid and measure what it actually holds.
const VT_CELL_AUDIT_INTERVAL_UNITS = 262144;
// Total code units the live grid may hold across all cells. 2 MiB of UTF-16 units is ~16x a
// 1000x1000 grid of single-unit cells; a grid past it is holding cell content that no terminal
// would display, which is the combining-character growth case. On breach the generation is
// STOPPED (terminal disposed) with a sticky reason — never silently reset to complete.
const VT_MAX_GRID_UNITS = 2097152;

// Read may wait for the queue to drain, bounded. On timeout it returns anyway and reports
// `lagging` — it never blocks indefinitely and never reports a currentness it did not measure.
const VT_DRAIN_WAIT_MS = 250;
const VT_DRAIN_WAIT_MAX_MS = 1000;

// Correction 2: bound `stream_id` lengths as well.
const VT_MAX_STREAM_ID_UNITS = 256;

// Correction 4: duplicate/backward output must not mutate the grid twice, and the overlap may
// only be verified against a BOUNDED retained window. Past it the module degrades rather than
// claiming verified equality or retaining unbounded history.
const VT_OVERLAP_WINDOW_UNITS = 65536;

const VT_LIMITS = Object.freeze({
  VT_MIN_DIMENSION,
  VT_MAX_DIMENSION,
  VT_SCROLLBACK,
  VT_QUEUE_MAX_UNITS,
  VT_QUEUE_MAX_OPS,
  VT_MAX_WRITE_CHUNK_UNITS,
  VT_MAX_ROW_CHARS_PER_COL,
  VT_MAX_SNAPSHOT_BYTES,
  VT_CELL_AUDIT_INTERVAL_UNITS,
  VT_MAX_GRID_UNITS,
  VT_DRAIN_WAIT_MS,
  VT_DRAIN_WAIT_MAX_MS,
  VT_MAX_STREAM_ID_UNITS,
  VT_OVERLAP_WINDOW_UNITS,
});

const UNIT_NAME = 'utf16_code_unit';

// Sticky, monotone non-decreasing. Loss is the most severe because it is the one that says
// units the consumer might reason about are MISSING; restore outranks attach because it says
// no VT state survived at all. A value never moves back down inside a generation.
const COMPLETENESS_RANK = Object.freeze({
  complete: 0,
  partial_since_attach: 1,
  partial_since_restore: 2,
  partial_after_loss: 3,
});

// Same discipline: once the module has stopped being able to verify contiguity it does not
// start claiming it again inside the same generation.
const CONTINUITY_RANK = Object.freeze({
  verified: 0,
  unverified: 1,
  conflicting: 2,
  invalid: 3,
});

const GENERATION_CAUSES = Object.freeze([
  'stream_origin',
  'attached_mid_stream',
  'stream_changed',
  'owner_replaced',
  'record_replaced',
  'restored',
]);

// Causes that may, on positive attestation, reach `complete`. A reconnect, an owner swap, a
// record swap and a restore never manufacture origin (correction 3), so they are absent here
// and their completeness is fixed at creation.
const ORIGIN_ELIGIBLE_CAUSES = Object.freeze([
  'stream_origin',
  'attached_mid_stream',
  'stream_changed',
]);

const VALID_GEOMETRY_SOURCES = Object.freeze(['local_pty', 'bridge_reported']);

// ---------------------------------------------------------------------------
// Dependency loading — lazy, optional, never fatal
// ---------------------------------------------------------------------------
//
// `@xterm/headless` is pinned in package.json, but this module must LOAD in an environment
// where it has not been installed: the rollout order puts the bridge before the daemon, and a
// daemon that cannot construct a VT must keep serving `/screen` unchanged and report the frame
// as `unavailable`. A missing dependency is an observation, not a crash.

let terminalCtorCache; // undefined = not yet attempted, null = unavailable, function = resolved
let terminalLoadError = null;

function loadTerminalCtor() {
  if (terminalCtorCache !== undefined) return terminalCtorCache;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@xterm/headless');
    terminalCtorCache = mod && typeof mod.Terminal === 'function' ? mod.Terminal : null;
    if (!terminalCtorCache) terminalLoadError = 'no_terminal_export';
  } catch (error) {
    terminalCtorCache = null;
    terminalLoadError = 'require_failed';
  }
  return terminalCtorCache;
}

// Test seam only — lets a harness inject a double, and lets G-NODE reset between cases.
function __setTerminalCtorForTest(ctor) {
  terminalCtorCache = ctor === undefined ? undefined : ctor;
  terminalLoadError = ctor ? null : terminalLoadError;
}

// ---------------------------------------------------------------------------
// Small validators — every one of them fails CLOSED to a named degraded reason
// ---------------------------------------------------------------------------

// THE one offset predicate, and the only route by which any stream offset — `stream_offset`,
// geometry `at_units`, a drop's `from_units`/`to_units` — may enter this module.
//
// Contract §4: "Offsets must be integers in [0, Number.MAX_SAFE_INTEGER]; anything else =>
// continuity: invalid => degraded." Correction 2: "Validate safe integers AND frame payload
// TYPES." So this is a TYPE test as much as a range test, and callers must hand it the RAW field.
// `Number(...)` on the way in defeats both halves: `Number("0")`, `Number(true)`, `Number([])`
// and `Number([0])` are each a legal-looking `0` produced from a payload that never stated an
// offset at all. Attesting an origin on one of those is attesting a fact no producer sent — the
// exact defect G-PEND/H6 reproduced with `at_units: "0"`. An offset is a NUMBER that already is
// a safe non-negative integer, or it is not an offset. `Number.isInteger` is itself typed
// (`Number.isInteger("0") === false`), so no separate `typeof` guard is needed here — what was
// needed, and is now the rule at every call site, is that nothing coerces before calling it.
//
// An ABSENT or `null` field is a different thing entirely and is NOT this function's business:
// those fields are documented OPTIONAL (§6 — an old bridge sends neither), and their absence
// means unknown/unverified. Each caller checks `undefined`/`null` first and degrades to
// unverified; only a field that is PRESENT and not an offset reaches the invalid path.
function isSafeOffset(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function sanitizeDimension(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < VT_MIN_DIMENSION || n > VT_MAX_DIMENSION) return null;
  return n;
}

function sanitizeStreamId(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > VT_MAX_STREAM_ID_UNITS) return null;
  return value;
}

function clampDrainWait(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return VT_DRAIN_WAIT_MS;
  return Math.min(n, VT_DRAIN_WAIT_MAX_MS);
}

// Split a JS string at `end` WITHOUT severing a surrogate pair. Splitting mid-escape-sequence
// is fine — the parser is streaming and reassembles across writes (that is what G-SPLIT
// measures) — but splitting a surrogate pair would hand the parser half a code point, which no
// amount of reassembly can undo because the halves are legal lone surrogates.
function safeSplitIndex(str, end) {
  if (end >= str.length) return str.length;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  return end;
}

// ---------------------------------------------------------------------------
// SessionScreen
// ---------------------------------------------------------------------------

/**
 * One SessionScreen per session record. It owns:
 *   - the current GENERATION (a VT terminal + a FIFO of ops + its qualification state),
 *   - the single ordering authority for output, resize and drop,
 *   - the observation frame read.
 *
 * It owns nothing else: no timers except the bounded drain wait, no sockets, no disk, no
 * registry of its peers, no worker-count cap.
 */
class SessionScreen {
  /**
   * @param {object} options
   * @param {string}   options.sessionId
   * @param {string}   [options.cause='attached_mid_stream'] — one of GENERATION_CAUSES
   * @param {number}   [options.cols] / [options.rows] — initial geometry, if positively known
   * @param {string}   [options.geometrySource='unverified'] — local_pty | bridge_reported | ...
   * @param {string}   [options.streamId]
   * @param {boolean}  [options.localSource=false] — the daemon itself produces these bytes
   * @param {Function} [options.terminalFactory] — test seam; defaults to @xterm/headless
   */
  constructor(options = {}) {
    this.sessionId = String(options.sessionId == null ? '' : options.sessionId);
    this.terminalFactory = typeof options.terminalFactory === 'function'
      ? options.terminalFactory
      : null;
    this.generationCounter = 0;
    this.frameSeq = 0;
    this.disposed = false;
    this.gen = null;
    // A record restored from disk is restored FOREVER, so the fact is held on the instance and
    // re-applied to every generation — including the ones this module rotates by itself, which
    // no caller is present to re-state it for.
    this.restoredRecord = options.restoredRecord === true;
    // INVARIANT (contract §7): geometry ALONE never destroys or mutates the live grid, its
    // counters or its generation. A geometry frame bearing a stream_id this generation is not
    // observing is not evidence that a new child started — only that stream's own confirmed
    // output is. Such a statement is parked HERE, in exactly ONE slot of fixed scalar fields
    // (never a collection, never a queue), and is applied only to the generation that stream's
    // first output creates, before that first unit reaches the VT. Cleared at every generation
    // and dispose fence by `_teardownGeneration`.
    this.pendingGeometry = null;
    this.newGeneration(options.cause || 'attached_mid_stream', options);
  }

  // -------------------------------------------------------------------------
  // Generations
  // -------------------------------------------------------------------------

  /**
   * Replace the whole VT + queue. A new stream_id, an owner swap, a record swap, a reconnect or
   * a restore each CREATE A GENERATION and none of them manufactures completeness (contract §5,
   * correction 3). Callbacks from the superseded generation update nothing: every one of them
   * closes over its generation token and checks it first.
   */
  newGeneration(cause, options = {}) {
    if (this.disposed) return null;
    const safeCause = GENERATION_CAUSES.includes(cause) ? cause : 'attached_mid_stream';
    this._teardownGeneration();

    this.generationCounter += 1;

    const cols = sanitizeDimension(options.cols);
    const rows = sanitizeDimension(options.rows);
    const requestedSource = typeof options.geometrySource === 'string'
      ? options.geometrySource
      : 'unverified';
    const geometryValid = cols !== null && rows !== null
      && VALID_GEOMETRY_SOURCES.includes(requestedSource);

    const localSource = options.localSource === true;

    const gen = {
      token: Object.create(null),
      index: this.generationCounter,
      cause: safeCause,
      localSource,
      streamId: sanitizeStreamId(options.streamId)
        || (localSource ? `local-${this.sessionId}-${this.generationCounter}` : null),

      // geometry
      cols: cols === null ? null : cols,
      rows: rows === null ? null : rows,
      geometrySource: geometryValid ? requestedSource : 'unverified',
      geometryKnownBeforeFirstOutput: geometryValid,

      // qualification
      completeness: null,       // assigned just below
      // `unverified` until an output op POSITIVELY verifies its position, and once degraded it
      // never climbs back inside the generation. A local generation is verified by construction:
      // the daemon's own PTY bytes reach `appendToOutputRing` through one function call, with no
      // channel in between that could drop, duplicate or reorder them.
      continuity: localSource ? 'verified' : 'unverified',
      continuityDegraded: false,
      originDetermined: false,
      degradedReasons: new Set(),

      // accounting — all in UTF-16 code units
      observedUnits: 0,         // units ACCEPTED for application in this generation
      appliedUnits: 0,          // units written AND acknowledged by the per-write callback
      droppedUnits: 0,          // units known lost: gap, queue overflow, explicit drop op
      queuedUnits: 0,
      streamPos: localSource ? 0 : null,  // stream-absolute offset of the next expected unit

      // queue
      queue: [],
      writing: false,
      drainWaiters: [],

      // duplicate/backward verification window (bounded)
      overlapTail: '',
      overlapTailStart: localSource ? 0 : null,

      // cell-growth audit
      unitsSinceCellAudit: 0,
      stopped: false,

      term: null,
    };

    // Completeness at creation. `complete` is only reachable from an origin-eligible cause, and
    // even then only via the one-shot attestation in `_determineOrigin`. Everything else is
    // fixed here and is sticky for the life of the generation.
    if (safeCause === 'restored') {
      gen.completeness = 'partial_since_restore';
    } else if (safeCause === 'stream_origin' && localSource && geometryValid) {
      // Direct spawn: the daemon creates this INSIDE its own spawn handler, before
      // `ptyProcess.onData` is registered, so unit 0 is the first unit it ever sees, and the
      // geometry is the one the daemon itself passed to `pty.spawn`. Both facts are first-hand.
      gen.completeness = 'complete';
      gen.originDetermined = true;
    } else {
      gen.completeness = 'partial_since_attach';
      if (!ORIGIN_ELIGIBLE_CAUSES.includes(safeCause)) gen.originDetermined = true;
    }

    // A record restored from disk kept NO VT state (`src/session-store/persistence.js` restores
    // `outputRing: []`). The mark is permanent on the record, so every generation on it is
    // floored here — the generation CAUSE stays accurate (a later owner really does attach
    // mid-stream) while completeness can never climb back to `complete`.
    if (options.restoredRecord === true) this.restoredRecord = true;
    if (this.restoredRecord) {
      this.gen = gen;
      this._degradeCompleteness('partial_since_restore');
      gen.originDetermined = true;
    }

    if (!geometryValid && (options.cols !== undefined || options.rows !== undefined)) {
      // Geometry was OFFERED and rejected — say which way it failed rather than looking like
      // geometry was never supplied.
      gen.geometrySource = (cols === null || rows === null) ? 'invalid' : 'unverified';
      gen.degradedReasons.add('geometry_invalid');
    }

    this.gen = gen;
    this._ensureTerminal();
    return gen;
  }

  _teardownGeneration() {
    const gen = this.gen;
    if (!gen) return;
    // Fence: an unconfirmed stream's parked geometry never survives an owner swap, a record
    // swap, a restore, a rotation or a dispose. The consuming path in `noteOutput` takes the
    // slot BEFORE calling `newGeneration`, so a legitimate respawn is unaffected by this.
    this.pendingGeometry = null;
    gen.queue.length = 0;
    gen.queuedUnits = 0;
    gen.writing = false;
    this._releaseDrainWaiters(gen);
    this._disposeTerm(gen);
    this.gen = null;
  }

  _disposeTerm(gen) {
    if (!gen || !gen.term) return;
    try {
      gen.term.dispose();
    } catch (error) {
      // A dispose that throws must not take the daemon with it. The reference is dropped either
      // way, which is the part that matters.
    }
    gen.term = null;
  }

  _ensureTerminal() {
    const gen = this.gen;
    if (!gen || gen.term || gen.stopped) return gen && gen.term;
    const Ctor = this.terminalFactory || loadTerminalCtor();
    if (!Ctor) {
      gen.degradedReasons.add(
        terminalLoadError === 'no_terminal_export' ? 'vt_library_invalid' : 'vt_library_unavailable'
      );
      return null;
    }
    const cols = gen.cols === null ? 80 : gen.cols;
    const rows = gen.rows === null ? 24 : gen.rows;
    try {
      // `cols`/`rows` are INIT-ONLY in the typings; later changes go through `resize()`, which
      // this module only ever calls from the head of its own queue.
      //
      // `allowProposedApi: true` is mandatory: `buffer` is marked (EXPERIMENTAL) and the option's
      // own doc says any use of a proposed API throws when it is false. See the PROPOSED API note
      // at the top of this file — it is the reason the version is pinned exactly.
      //
      // `windowOptions` is deliberately absent. No reply/OSC/title/clipboard sink is wired.
      gen.term = new Ctor({
        cols,
        rows,
        scrollback: VT_SCROLLBACK,
        allowProposedApi: true,
      });
    } catch (error) {
      gen.term = null;
      gen.degradedReasons.add('vt_construct_failed');
      return null;
    }
    if (gen.cols === null) gen.cols = cols;
    if (gen.rows === null) gen.rows = rows;
    return gen.term;
  }

  // -------------------------------------------------------------------------
  // Qualification helpers — every transition is one-way inside a generation
  // -------------------------------------------------------------------------

  _degradeCompleteness(value) {
    const gen = this.gen;
    if (!gen) return;
    const next = COMPLETENESS_RANK[value];
    if (next === undefined) return;
    if (next > COMPLETENESS_RANK[gen.completeness]) gen.completeness = value;
  }

  _degradeContinuity(value) {
    const gen = this.gen;
    if (!gen) return;
    const next = CONTINUITY_RANK[value];
    if (next === undefined) return;
    gen.continuityDegraded = true;
    if (next > CONTINUITY_RANK[gen.continuity]) gen.continuity = value;
  }

  /**
   * The ONLY writer that can say `verified`, and it refuses once anything has degraded. An
   * output op earns it by carrying both U2 fields with a position this generation could check.
   */
  _verifyContinuity() {
    const gen = this.gen;
    if (!gen || gen.continuityDegraded) return;
    gen.continuity = 'verified';
  }

  _noteLoss(units, reason) {
    const gen = this.gen;
    if (!gen) return;
    if (isSafeOffset(units) && units > 0) {
      gen.droppedUnits = Math.min(gen.droppedUnits + units, Number.MAX_SAFE_INTEGER);
    }
    gen.degradedReasons.add(reason);
    this._degradeCompleteness('partial_after_loss');
  }

  /**
   * The ONE-SHOT origin determination for a bridge-fed generation, evaluated at the moment the
   * generation's first output op is accepted (contract §5, correction 3).
   *
   * `complete` requires a POSITIVELY ATTESTED child origin — this unit is stream offset 0 for
   * this stream_id — AND an initial geometry that arrived BEFORE it. A new stream_id alone is
   * not proof of a new child start, so it is not enough on its own. After this call the value
   * is sticky and can only worsen.
   */
  _determineOrigin(streamOffset, streamId) {
    const gen = this.gen;
    if (!gen || gen.originDetermined) return;
    gen.originDetermined = true;
    if (gen.completeness !== 'partial_since_attach') return;   // already worse — leave it
    if (!ORIGIN_ELIGIBLE_CAUSES.includes(gen.cause)) return;
    if (streamOffset !== 0) return;
    if (!gen.geometryKnownBeforeFirstOutput) return;
    if (!VALID_GEOMETRY_SOURCES.includes(gen.geometrySource)) return;
    if (gen.streamId && streamId && gen.streamId !== streamId) return;
    if (gen.degradedReasons.size > 0) return;
    gen.completeness = 'complete';
  }

  // -------------------------------------------------------------------------
  // Producers — output, geometry, drop. ONE FIFO for all three (contract §7).
  // -------------------------------------------------------------------------

  /**
   * Accept one chunk of session output.
   *
   * @param {string} data — the SAME JS string the daemon appended to `outputRing`
   * @param {object} [meta] — `{ stream_id, stream_offset }` from the bridge (U2). Absent on the
   *   direct-spawn path, where the daemon is the producer and there is no channel to lose bytes
   *   over; that generation is constructed with `localSource: true` and stays `verified`.
   */
  noteOutput(data, meta) {
    const gen = this.gen;
    if (this.disposed || !gen) return;

    if (typeof data !== 'string') {
      // Correction 2: validate frame payload TYPES, not only offsets. A non-string `data` is a
      // malformed frame; counting its `.length` would be an invented measurement.
      gen.degradedReasons.add('invalid_output_payload');
      this._degradeContinuity('invalid');
      return;
    }
    if (data.length === 0) return;

    let streamId = null;
    let streamOffset = null;

    if (meta && meta.stream_id !== undefined && meta.stream_id !== null) {
      streamId = sanitizeStreamId(meta.stream_id);
      if (streamId === null) {
        // F4 / contract §7: a generation is fenced on its IDENTITY. A unit whose claimed origin
        // is present but unusable is not a unit of this generation, so it is REFUSED here —
        // before rotation, before any position/anchor arithmetic, before the overlap window,
        // before the queue, before observed/applied accounting and therefore before the grid.
        // Admitting it would parse attacker-influenced text of unknown provenance into a grid
        // that is being reported as this stream's observation; that is the invalid-origin data
        // admission, and it is a defect independently of whatever completeness the generation
        // already carried.
        //
        // What is recorded is the OBSERVATION that a malformed identity arrived: the named
        // reason (so the frame reads `vt_grid_degraded`) and `continuity: invalid`. What is NOT
        // recorded is any invented fact — no `_noteLoss`, because these units were never units
        // of this stream and their count is not a measured loss FROM it; no new generation and
        // no origin, because a malformed id is not proof that a child started.
        //
        // ABSENT/`null` `stream_id` is a different thing and does not reach here: it is the
        // documented OPTIONAL legacy case (an old bridge sends no identity) and stays unknown,
        // handled by the unverified path below. Only a PRESENT-and-invalid id is malformed.
        gen.degradedReasons.add('invalid_stream_id');
        this._degradeContinuity('invalid');
        return;
      }
    }
    if (meta && meta.stream_offset !== undefined && meta.stream_offset !== null) {
      // The RAW field goes to `isSafeOffset` — see its note. A present-but-not-a-number
      // `stream_offset` is a malformed frame, and the position it claims is unknown; it is never
      // turned into a number that this generation would then measure a gap, an overlap or an
      // ORIGIN against.
      if (isSafeOffset(meta.stream_offset)) {
        streamOffset = meta.stream_offset;
      } else {
        gen.degradedReasons.add('invalid_stream_offset');
        this._degradeContinuity('invalid');
      }
    }

    // A different stream_id is a NEW CHILD as far as the bridge is concerned, so it is a new
    // generation — but per correction 3 that fact alone does not make it an origin. The new
    // generation starts `partial_since_attach` and only the offset-0 attestation below can
    // change that.
    if (streamId !== null && gen.streamId !== null && streamId !== gen.streamId
        && !gen.localSource) {
      // Output is the confirmation a new stream needs, so this is the ONLY place a stream change
      // may replace the live generation. The old stream's geometry never carries across: the new
      // child may have been spawned at a different size. The only geometry that may be applied
      // here is one this same stream parked for this exact offset before its first output unit
      // (§7 / F2) — it is installed into the new generation, so it reaches the VT strictly
      // before that unit does.
      const pending = this._takePendingGeometry(streamId, streamOffset);
      const genOptions = { streamId, geometrySource: 'unverified' };
      if (pending && !pending.unusable) {
        genOptions.cols = pending.cols;
        genOptions.rows = pending.rows;
        genOptions.geometrySource = pending.geometrySource;
      }
      const next = this.newGeneration('stream_changed', genOptions);
      if (next && pending && pending.unusable) {
        // Geometry for this stream existed but its order or content was lost or ambiguous. Say
        // so, so the generation cannot be qualified `complete` on it (`_determineOrigin` refuses
        // on any degraded reason) — never silently treated as if none had been sent.
        next.degradedReasons.add('geometry_pending_unusable');
      }
      return this.noteOutput(data, meta);
    }
    if (streamId !== null && gen.streamId === null) gen.streamId = streamId;

    let payload = data;

    if (!gen.localSource) {
      if (streamOffset === null || streamId === null) {
        // An old bridge sends neither field. The daemon then refuses to qualify rather than
        // inventing the fact: unverified, never a false `verified`.
        this._degradeContinuity('unverified');
        if (gen.streamPos !== null) gen.streamPos += payload.length;
      } else if (gen.streamPos === null) {
        // First positioned frame of this generation: adopt its offset as the anchor. Adopting an
        // anchor is not the same as knowing the origin — `_determineOrigin` below still requires
        // the offset to actually BE 0.
        gen.streamPos = streamOffset;
      } else if (streamOffset > gen.streamPos) {
        // GAP of exactly this many units. Known lost, counted, sticky.
        this._noteLoss(streamOffset - gen.streamPos, 'gap');
        gen.streamPos = streamOffset;
        gen.overlapTail = '';
        gen.overlapTailStart = streamOffset;
      } else if (streamOffset < gen.streamPos) {
        // DUPLICATE / BACKWARD. The overlapping prefix must not mutate the grid a second time.
        const overlap = gen.streamPos - streamOffset;
        const verifiable = gen.overlapTailStart !== null
          && streamOffset >= gen.overlapTailStart
          && gen.overlapTailStart + gen.overlapTail.length >= streamOffset + Math.min(overlap, payload.length);
        if (verifiable) {
          const from = streamOffset - gen.overlapTailStart;
          const span = Math.min(overlap, payload.length);
          const previously = gen.overlapTail.slice(from, from + span);
          if (previously !== payload.slice(0, span)) {
            // Correction 4: bounded verification found a genuine disagreement. Say so.
            gen.degradedReasons.add('overlap_conflict');
            this._degradeContinuity('conflicting');
            this._degradeCompleteness('partial_after_loss');
          }
        } else {
          // The old units are outside the retained window. Degrade rather than claiming verified
          // equality, and rather than retaining unbounded history to be able to claim it.
          gen.degradedReasons.add('overlap_unverifiable');
          this._degradeContinuity('unverified');
        }
        payload = overlap >= payload.length ? '' : payload.slice(overlap);
        if (payload.length === 0) {
          // Entirely a replay. Nothing is applied, nothing is counted — and crucially the grid is
          // not mutated twice.
          return;
        }
      }
      if (streamOffset !== null) {
        gen.streamPos = streamOffset + data.length;
        if (streamId !== null) this._verifyContinuity();
      }
    } else {
      gen.streamPos = (gen.streamPos === null ? 0 : gen.streamPos) + payload.length;
    }

    if (!gen.originDetermined) {
      this._determineOrigin(gen.localSource ? 0 : streamOffset, streamId);
    }

    this._retainOverlap(gen, payload);
    this._enqueue({ kind: 'output', data: payload, units: payload.length });
  }

  /**
   * Accept a geometry statement.
   *
   * @param {object} geo
   * @param {number} geo.cols / geo.rows
   * @param {string} [geo.streamId]
   * @param {number|null} [geo.atUnits] — the stream offset at which the producer APPLIED this
   *   resize. Absent/`null` is self-stamped ONLY for the direct LOCAL producer (the daemon
   *   executes `ptyProcess.resize` and therefore knows the exact stream position first-hand, so
   *   there is nothing to cross-check against). From any other producer an omitted boundary is
   *   UNKNOWN: the dimensions are still applied, but the geometry is `unverified` and cannot
   *   attest an origin (F5).
   * @param {string} [geo.source='bridge_reported']
   */
  noteGeometry(geo) {
    const gen = this.gen;
    if (this.disposed || !gen || !geo) return;

    // The stream is resolved FIRST, before this generation's geometry state is touched at all:
    // a frame that turns out to belong to another stream must leave this one exactly as it was.
    const streamId = geo.streamId === undefined || geo.streamId === null
      ? null
      : sanitizeStreamId(geo.streamId);
    if (geo.streamId !== undefined && geo.streamId !== null && streamId === null) {
      gen.degradedReasons.add('invalid_stream_id');
      gen.geometrySource = 'unverified';
      return;
    }

    // CONTRACT §7: "Geometry carrying a different stream_id than the current generation is
    // discarded, not applied." A NEW CHILD does announce its geometry BEFORE its first output
    // unit, so that statement still has to be usable — but geometry alone is not proof that a
    // new child started (correction 3: a new stream_id is not itself that proof). Rotating on it
    // let one stale, reordered or malformed geometry frame destroy a live, qualified grid.
    // So it is PARKED, not applied and not rotated on: the live generation, its grid, its
    // counters and its qualification are left untouched, and `noteOutput` adopts the parked
    // geometry only once that same stream's first output CONFIRMS the child, and only at the
    // exact offset the geometry claimed. An old stream's geometry is never applied to a new one.
    if (streamId !== null && gen.streamId !== null && streamId !== gen.streamId
        && !gen.localSource) {
      this._parkPendingGeometry(streamId, geo);
      return;
    }

    const cols = sanitizeDimension(geo.cols);
    const rows = sanitizeDimension(geo.rows);
    if (cols === null || rows === null) {
      // Out of 1..1000, or not an integer. The VT keeps its last valid geometry.
      gen.geometrySource = 'invalid';
      gen.degradedReasons.add('geometry_invalid');
      return;
    }

    const source = VALID_GEOMETRY_SOURCES.includes(geo.source) ? geo.source : 'bridge_reported';
    if (streamId !== null && this.gen.streamId === null) this.gen.streamId = streamId;

    // `at_units` is the stream offset at which the producer APPLIED this resize, so it is an
    // offset and goes through the one offset predicate UNCOERCED. Present-but-not-an-offset is a
    // malformed statement of position, and the geometry stops being something this module can say
    // it knows. Absent/null is OPTIONAL and means UNKNOWN — whether that unknown may still be
    // self-stamped is decided by producer trust immediately below, not here.
    let atUnits = null;
    if (geo.atUnits !== undefined && geo.atUnits !== null) {
      if (!isSafeOffset(geo.atUnits)) {
        gen.degradedReasons.add('geometry_at_units_invalid');
        gen.geometrySource = 'unverified';
        return;
      }
      atUnits = geo.atUnits;
    }

    // F5 / contract §6-§7: WHO is allowed to omit the boundary.
    //
    // §6 defines `at_units` as the BRIDGE's stream offset and §7 requires that boundary to be
    // CHECKED against the queue; §6's rule for a field the producer never sent is `unverified`.
    // Omitting it is legitimate for exactly ONE producer: the direct LOCAL one, which executed
    // `ptyProcess.resize` itself and therefore knows the exact stream position first-hand — there
    // is nothing to cross-check against because it IS the source. For anybody else an omitted
    // boundary is UNKNOWN, never a self-attestation of `0`: the daemon would otherwise invent the
    // boundary it was never told and then qualify an origin on its own invention.
    //
    // The trusted-producer test is `gen.localSource`, which the daemon sets inside its own spawn
    // handler. It is deliberately NOT `geo.source === 'local_pty'`: that string is caller/wire
    // data, and neither a producer string nor the mere ABSENCE of metadata may grant local
    // authority. This preserves the existing trusted-producer invariant rather than widening it.
    //
    // This is the same evidence requirement `_parkPendingGeometry` already enforces on the
    // PENDING path (`usable` requires `atUnits !== null`, so an unattested parked geometry can
    // only ever be `geometry_pending_unusable`). Applying it here closes the disagreement between
    // the two geometry paths, and matches how output's own `stream_offset` already treats
    // absent/null as `unverified` rather than as proof of 0.
    const selfStamped = atUnits === null && gen.localSource === true;
    const unattested = atUnits === null && !selfStamped;

    // The boundary this op claims to sit at, computed HERE, in arrival order, because the queue
    // is FIFO and this is the accumulated unit count for the stream at this point.
    let anchor;
    if (atUnits === null) {
      anchor = gen.streamPos === null ? 0 : gen.streamPos;
    } else if (gen.streamPos === null) {
      // No positioned output yet in this generation — adopt the stated boundary as the anchor.
      anchor = atUnits;
      gen.streamPos = atUnits;
    } else {
      anchor = gen.streamPos;
    }

    this._enqueue({
      kind: 'resize',
      cols,
      rows,
      streamId,
      // An unattested boundary stays `null` rather than being stamped with `anchor`: writing the
      // anchor in would recreate the defect one layer down, as a stated boundary that trivially
      // equals the position it was copied from and so "passes" the §7 check.
      atUnits: unattested ? null : (atUnits === null ? anchor : atUnits),
      anchor,
      selfStamped,
      unattested,
      source,
    });
  }

  /**
   * Park the initial geometry of a stream this module has not yet observed any output from.
   *
   * BOUND (correction 2/6): exactly ONE slot holding a fixed set of scalars — an already-bounded
   * `stream_id`, two dimensions in 1..1000, a safe offset and two flags. It is replaced, never
   * appended to, so a flood of geometry frames for unconfirmed streams costs a constant amount
   * of memory and cannot grow the op queue or the retained overlap window.
   *
   * Ambiguity is recorded rather than resolved: the module never guesses which of two
   * unconfirmed streams is the next child, and an ambiguous slot can only ever be dropped, so
   * no generation can reach `complete` on a geometry whose order was lost.
   */
  _parkPendingGeometry(streamId, geo) {
    const cols = sanitizeDimension(geo.cols);
    const rows = sanitizeDimension(geo.rows);
    const source = VALID_GEOMETRY_SOURCES.includes(geo.source) ? geo.source : 'bridge_reported';
    // Same rule as the applied path, and it matters MORE here: this offset is the only thing
    // that will later be matched against the new stream's first output position, so a coerced
    // one would attest an origin boundary the producer never stated. Raw field, one predicate,
    // no `Number(...)`.
    let atUnits = null;
    if (geo.atUnits !== undefined && geo.atUnits !== null && isSafeOffset(geo.atUnits)) {
      atUnits = geo.atUnits;
    }
    // Without dimensions in range AND a stated offset there is nothing that could later be
    // applied in a verifiable order, so the slot can only be a record of ambiguity.
    const usable = cols !== null && rows !== null && atUnits !== null;

    const prior = this.pendingGeometry;
    if (prior && prior.streamId === streamId) {
      // The FIRST statement is the initial geometry and is kept. A second one that disagrees
      // means the initial geometry for this stream is no longer unambiguous.
      if (!usable || prior.cols !== cols || prior.rows !== rows || prior.atUnits !== atUnits) {
        prior.ambiguous = true;
      }
      return;
    }

    this.pendingGeometry = {
      streamId,
      cols,
      rows,
      source,
      atUnits,
      // Displacing another unconfirmed stream's statement is itself ambiguous: two unconfirmed
      // streams cannot both be the next child, and nothing here can tell which one is.
      ambiguous: !usable || prior !== null,
    };
  }

  /**
   * Take the parked geometry for a stream that has just been confirmed by its own output.
   *
   * Returns `null` when nothing was parked for this stream, `{unusable: true}` when something
   * was parked but its order relative to the first output unit was lost or ambiguous, and the
   * geometry otherwise. The exact-offset test is what makes "before its first confirmed output"
   * a measured fact rather than an assumption.
   */
  _takePendingGeometry(streamId, streamOffset) {
    const pending = this.pendingGeometry;
    if (!pending || pending.streamId !== streamId) return null;
    this.pendingGeometry = null;
    if (pending.ambiguous || streamOffset === null || pending.atUnits !== streamOffset) {
      return { unusable: true };
    }
    return { cols: pending.cols, rows: pending.rows, geometrySource: pending.source };
  }

  /**
   * Accept an explicit drop statement — the bridge's pre-connect hold overflowed and is saying
   * so at the exact position, so the daemon records a gap instead of receiving a lie.
   */
  noteDropped(drop) {
    const gen = this.gen;
    if (this.disposed || !gen || !drop) return;

    // A drop's bounds are stream offsets and are validated as such, uncoerced: the span `to -
    // from` is COUNTED into `dropped_units`, so a coerced bound would fabricate a measured loss
    // size — or, with `"0"` for both, fabricate a loss of exactly nothing — out of a frame that
    // stated no position. Unlike `stream_offset` and `at_units`, neither bound is optional:
    // absent, null or non-numeric is a statement that something was lost at an unknown position,
    // and the branch below already records exactly that.
    const from = drop.fromUnits;
    const to = drop.toUnits;
    const streamId = drop.streamId === undefined || drop.streamId === null
      ? null
      : sanitizeStreamId(drop.streamId);

    // A present-but-malformed identity is not the legacy absent identity. Reject it before
    // validating or enqueuing bounds: its units are not attributable to this generation, so
    // recording them as known loss would contaminate the current stream.
    if (drop.streamId !== undefined && drop.streamId !== null && streamId === null) {
      gen.degradedReasons.add('invalid_stream_id');
      this._degradeContinuity('invalid');
      return;
    }

    if (!isSafeOffset(from) || !isSafeOffset(to) || to < from) {
      // Correction 2: a malformed drop message is still a statement that SOMETHING was lost. It
      // is recorded as loss of unknown size rather than discarded.
      gen.degradedReasons.add('drop_bounds_invalid');
      this._degradeCompleteness('partial_after_loss');
      return;
    }

    this._enqueue({ kind: 'dropped', streamId, fromUnits: from, toUnits: to, units: to - from });
  }

  _retainOverlap(gen, payload) {
    if (gen.localSource || payload.length === 0) return;
    if (gen.overlapTailStart === null) {
      gen.overlapTailStart = gen.streamPos === null ? 0 : Math.max(0, gen.streamPos - payload.length);
    }
    gen.overlapTail += payload;
    if (gen.overlapTail.length > VT_OVERLAP_WINDOW_UNITS) {
      const excess = gen.overlapTail.length - VT_OVERLAP_WINDOW_UNITS;
      gen.overlapTail = gen.overlapTail.slice(excess);
      gen.overlapTailStart += excess;
    }
  }

  // -------------------------------------------------------------------------
  // The single FIFO (contract §7)
  // -------------------------------------------------------------------------

  _enqueue(op) {
    const gen = this.gen;
    if (!gen || gen.stopped) {
      if (gen && op.kind === 'output') this._noteLoss(op.units, 'generation_stopped');
      return;
    }

    const units = op.kind === 'output' ? op.units : 0;
    if (gen.queue.length + 1 > VT_QUEUE_MAX_OPS
        || gen.queuedUnits + units > VT_QUEUE_MAX_UNITS) {
      // OVERLOAD. Stop accepting and COUNT the loss; the alternative — dropping the oldest, as
      // the bridge's pre-connect hold used to — turns an overflow into a silent reorder of the
      // grid's history, which is worse than an honest gap.
      this._noteLoss(units, op.kind === 'output' ? 'queue_overflow' : 'queue_overflow_op');
      return;
    }

    gen.queue.push(op);
    gen.queuedUnits += units;
    if (op.kind === 'output') {
      gen.observedUnits += op.units;
      op.watermark = gen.observedUnits;
    }
    this._pump();
  }

  _pump() {
    const gen = this.gen;
    if (!gen || gen.writing || gen.stopped) return;

    // Non-output ops are executed synchronously at the head of the queue, one at a time, so a
    // resize lands at exactly the stream position the child saw it — never "on arrival", and
    // never after writes that were enqueued behind it.
    while (gen.queue.length > 0 && gen.queue[0].kind !== 'output') {
      const op = gen.queue.shift();
      if (op.kind === 'resize') this._applyResize(gen, op);
      else if (op.kind === 'dropped') this._applyDropped(gen, op);
      if (this.gen !== gen || gen.stopped) return;
    }

    if (gen.queue.length === 0) {
      this._releaseDrainWaiters(gen);
      return;
    }

    const term = this._ensureTerminal();
    if (!term) {
      // No VT to write into. The units stay accounted as observed-but-not-applied, which reads
      // as `lagging` with a named degraded reason — never as `current`.
      return;
    }

    // Consecutive output ops up to the next non-output op may be concatenated into one write.
    // They may NEVER be merged across a resize or a dropped boundary.
    let chunk = '';
    let watermark = gen.appliedUnits;
    while (gen.queue.length > 0
           && gen.queue[0].kind === 'output'
           && chunk.length < VT_MAX_WRITE_CHUNK_UNITS) {
      const op = gen.queue[0];
      const room = VT_MAX_WRITE_CHUNK_UNITS - chunk.length;
      if (op.data.length <= room) {
        gen.queue.shift();
        gen.queuedUnits -= op.units;
        chunk += op.data;
        watermark = op.watermark;
      } else {
        // Bound the parser INPUT: slice this op and leave the remainder at the head, with its
        // watermark adjusted so the accounting stays exact.
        const cut = safeSplitIndex(op.data, room);
        if (cut === 0) break;                       // room too small for even one code point
        const head = op.data.slice(0, cut);
        op.data = op.data.slice(cut);
        op.units -= cut;
        gen.queuedUnits -= cut;
        chunk += head;
        watermark = op.watermark - op.units;
        break;
      }
    }

    if (chunk.length === 0) {
      this._releaseDrainWaiters(gen);
      return;
    }

    const token = gen.token;
    gen.writing = true;
    const onWritten = () => {
      // Generation fencing: a callback from a superseded generation updates NOTHING. This is the
      // only defence against a late callback resurrecting a disposed terminal's accounting.
      if (this.disposed || !this.gen || this.gen.token !== token) return;
      const live = this.gen;
      live.writing = false;
      // `max`, never `=`: no assumption is made about callback ordering, so an out-of-order
      // callback can never regress `applied_units`.
      live.appliedUnits = Math.max(live.appliedUnits, watermark);
      live.unitsSinceCellAudit += chunk.length;
      if (live.unitsSinceCellAudit >= VT_CELL_AUDIT_INTERVAL_UNITS) {
        live.unitsSinceCellAudit = 0;
        this._auditCellGrowth(live);
        if (live.stopped) return;
      }
      this._pump();
    };

    try {
      // `onWriteParsed` is deliberately NOT used as the watermark: its own doc says it "fires at
      // most once per frame ... can fire when there are still writes pending". Only the
      // per-`write` callback may advance `applied_units`.
      term.write(chunk, onWritten);
    } catch (error) {
      gen.writing = false;
      gen.degradedReasons.add('vt_write_failed');
      this._noteLoss(chunk.length, 'vt_write_failed');
      this._releaseDrainWaiters(gen);
    }
  }

  _applyResize(gen, op) {
    if (op.streamId !== null && gen.streamId !== null && op.streamId !== gen.streamId) {
      // Geometry carrying a different stream_id than the current generation is DISCARDED, not
      // applied — it describes a child this generation is not observing.
      gen.degradedReasons.add('geometry_stream_mismatch');
      return;
    }
    if (!op.selfStamped && !op.unattested && op.atUnits !== op.anchor) {
      // Boundary validation failed: the producer says it resized at a stream position this queue
      // never reached. Apply NOTHING and stop claiming the geometry is known.
      gen.geometrySource = 'unverified';
      gen.degradedReasons.add('geometry_boundary_mismatch');
      return;
    }

    // F5: an unattested boundary is not a MISMATCH — there is no stated position to disagree
    // with — so the dimensions are still applied and the grid stays usable. What it cannot do is
    // supply evidence: the geometry is reported `unverified`, the named reason makes the frame
    // explicitly degraded, and it must not set `geometryKnownBeforeFirstOutput`, which is exactly
    // the "initial geometry arrived before unit 0" evidence `_determineOrigin` requires for
    // `complete`. No gap and no loss is invented, and no offset unit is reinterpreted — the
    // observation is downgraded, not fabricated.
    if (op.unattested) gen.degradedReasons.add('geometry_at_units_unattested');
    const appliedSource = op.unattested ? 'unverified' : op.source;

    const term = this._ensureTerminal();
    if (!term) {
      gen.cols = op.cols;
      gen.rows = op.rows;
      gen.geometrySource = appliedSource;
      return;
    }
    try {
      // Synchronous by declaration, and executed HERE — at the head of the queue — which is the
      // only place a synchronous call can be ordered against asynchronous writes.
      term.resize(op.cols, op.rows);
      gen.cols = op.cols;
      gen.rows = op.rows;
      gen.geometrySource = appliedSource;
      if (!op.unattested && gen.observedUnits === 0) gen.geometryKnownBeforeFirstOutput = true;
    } catch (error) {
      gen.degradedReasons.add('vt_resize_failed');
      gen.geometrySource = 'unverified';
    }
  }

  _applyDropped(gen, op) {
    this._noteLoss(op.units, 'explicit_drop');
    if (op.toUnits > (gen.streamPos === null ? 0 : gen.streamPos)) gen.streamPos = op.toUnits;
    // The retained overlap window describes units before the drop; it cannot verify anything
    // across it.
    gen.overlapTail = '';
    gen.overlapTailStart = op.toUnits;
  }

  /**
   * Correction 6 — snapshot truncation bounds the SERIALIZATION, not the grid. An xterm cell
   * accumulates combining characters across writes, so a 1-cell grid can hold megabytes while
   * every snapshot of it looks small. Walk the grid periodically and measure what it holds; on
   * breach STOP the generation (dispose the terminal) with a sticky reason. It is never silently
   * reset, and it never returns to `complete`.
   */
  _auditCellGrowth(gen) {
    const term = gen.term;
    if (!term) return;
    let total = 0;
    try {
      const buffer = term.buffer.active;
      const rows = gen.rows === null ? 0 : gen.rows;
      for (let i = 0; i < rows; i += 1) {
        const line = buffer.getLine(buffer.baseY + i);
        if (!line) continue;
        total += line.translateToString(false).length;
        if (total > VT_MAX_GRID_UNITS) break;
      }
    } catch (error) {
      gen.degradedReasons.add('cell_audit_failed');
      return;
    }
    if (total > VT_MAX_GRID_UNITS) {
      gen.degradedReasons.add('cell_growth_bound_exceeded');
      this._degradeCompleteness('partial_after_loss');
      this._stopGeneration(gen);
    }
  }

  _stopGeneration(gen) {
    gen.stopped = true;
    gen.writing = false;
    let lost = 0;
    for (const op of gen.queue) if (op.kind === 'output') lost += op.units;
    gen.queue.length = 0;
    gen.queuedUnits = 0;
    if (lost > 0) gen.droppedUnits += lost;
    this._disposeTerm(gen);
    this._releaseDrainWaiters(gen);
  }

  _releaseDrainWaiters(gen) {
    if (!gen || gen.drainWaiters.length === 0) return;
    const waiters = gen.drainWaiters;
    gen.drainWaiters = [];
    for (const resolve of waiters) {
      try { resolve(); } catch (error) { /* a waiter's own failure is not this module's */ }
    }
  }

  // -------------------------------------------------------------------------
  // Read (contract §9) — observation only. Never mutates the queue.
  // -------------------------------------------------------------------------

  /**
   * @param {object} [options]
   * @param {number}  [options.drainWaitMs=250] — bounded, hard max 1000
   * @param {boolean} [options.ownerDisconnected=false] — wrapped session, owner socket down
   * @returns {Promise<object>} the frame described in contract §9
   */
  async readFrame(options = {}) {
    const waitMs = clampDrainWait(options.drainWaitMs);
    if (waitMs > 0) await this._waitForDrain(waitMs);
    return this.readFrameSync(options);
  }

  _waitForDrain(ms) {
    const gen = this.gen;
    if (!gen || gen.stopped || (!gen.writing && gen.queue.length === 0)) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (typeof timer.unref === 'function') timer.unref();
      gen.drainWaiters.push(finish);
    });
  }

  /** The same frame, without the bounded drain wait. */
  readFrameSync(options = {}) {
    this.frameSeq += 1;
    const gen = this.gen;
    const ownerDisconnected = options.ownerDisconnected === true;

    if (!gen) {
      return {
        session_id: this.sessionId,
        unit: UNIT_NAME,
        observation_basis: 'unavailable',
        degraded_reasons: ['vt_disposed'],
        completeness: 'partial_since_attach',
        vt_generation: this.generationCounter,
        generation_cause: 'attached_mid_stream',
        frame_seq: this.frameSeq,
        applied_units: 0,
        observed_units: 0,
        lag_units: 0,
        freshness: ownerDisconnected ? 'stale_owner_disconnected' : 'lagging',
        continuity: 'unverified',
        stream_id: null,
        dropped_units: 0,
        cols: null,
        rows: null,
        geometry_source: 'unverified',
        screen_kind: null,
        cursor: null,
        rows_text: [],
        snapshot_bytes: 0,
        snapshot_truncated: false,
      };
    }

    const reasons = new Set(gen.degradedReasons);

    let freshness;
    if (ownerDisconnected) {
      // A wrapped session whose owner socket is down cannot be `current` at any lag: nothing is
      // arriving, so equality of the two counters says only that the module applied what it was
      // given, not that the screen is what the child is showing.
      freshness = 'stale_owner_disconnected';
    } else if (!gen.stopped && gen.appliedUnits === gen.observedUnits) {
      freshness = 'current';
    } else {
      freshness = 'lagging';
    }

    const snapshot = this._snapshot(gen);
    for (const reason of snapshot.reasons) reasons.add(reason);

    let basis;
    if (!gen.term || gen.stopped) {
      basis = 'unavailable';
    } else if (gen.completeness === 'complete'
      && VALID_GEOMETRY_SOURCES.includes(gen.geometrySource)
      && gen.continuity === 'verified'
      && freshness === 'current'
      && reasons.size === 0) {
      basis = 'vt_grid';
    } else {
      basis = 'vt_grid_degraded';
    }

    return {
      session_id: this.sessionId,
      unit: UNIT_NAME,
      observation_basis: basis,
      degraded_reasons: Array.from(reasons).sort(),
      completeness: gen.completeness,
      vt_generation: gen.index,
      generation_cause: gen.cause,
      frame_seq: this.frameSeq,
      applied_units: gen.appliedUnits,
      observed_units: gen.observedUnits,
      lag_units: Math.max(0, gen.observedUnits - gen.appliedUnits),
      freshness,
      continuity: gen.continuity,
      stream_id: gen.streamId,
      dropped_units: gen.droppedUnits,
      cols: gen.cols,
      rows: gen.rows,
      geometry_source: gen.geometrySource,
      screen_kind: snapshot.screenKind,
      cursor: snapshot.cursor,
      rows_text: snapshot.rowsText,
      snapshot_bytes: snapshot.bytes,
      snapshot_truncated: snapshot.truncated,
    };
  }

  _snapshot(gen) {
    const empty = {
      rowsText: [], bytes: 0, truncated: false, cursor: null, screenKind: null, reasons: [],
    };
    if (!gen.term || gen.stopped) return empty;

    const reasons = [];
    const rowsText = [];
    let bytes = 0;
    let truncated = false;
    let cursor = null;
    let screenKind = null;

    try {
      const buffer = gen.term.buffer.active;
      screenKind = buffer.type === 'alternate' ? 'alternate' : 'normal';
      cursor = { x: buffer.cursorX, y: buffer.cursorY };
      const cols = gen.cols === null ? 0 : gen.cols;
      const rows = gen.rows === null ? 0 : gen.rows;
      const maxRowChars = Math.max(1, cols * VT_MAX_ROW_CHARS_PER_COL);

      for (let i = 0; i < rows; i += 1) {
        const line = buffer.getLine(buffer.baseY + i);
        let text = line ? line.translateToString(true) : '';
        if (text.length > maxRowChars) {
          // A cell is not a character; one combining/ZWJ cell can carry many code units, so a
          // row can exceed `cols` in units without exceeding it in cells.
          text = text.slice(0, safeSplitIndex(text, maxRowChars));
          if (reasons.indexOf('row_truncated') === -1) reasons.push('row_truncated');
        }
        const rowBytes = Buffer.byteLength(text, 'utf8') + 1;   // +1 for the row separator
        if (bytes + rowBytes > VT_MAX_SNAPSHOT_BYTES) {
          truncated = true;
          reasons.push('snapshot_truncated');
          break;
        }
        bytes += rowBytes;
        rowsText.push(text);
      }
    } catch (error) {
      return { ...empty, reasons: ['snapshot_failed'] };
    }

    return { rowsText, bytes, truncated, cursor, screenKind, reasons };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._teardownGeneration();
  }
}

// ---------------------------------------------------------------------------
// Session-record helpers
// ---------------------------------------------------------------------------
//
// These attach ONE SessionScreen to a session record as `session.vtScreen`. That is not a
// registry: there is no collection, no sweeper, no lookup by anything other than the record the
// caller already holds, and no cap on how many exist.
//
// EVERY ONE OF THEM IS TOTAL. The observation path must never be able to break the terminal
// path: an unexpected failure here degrades the frame, it does not throw into
// `appendToOutputRing`.

function ensureSessionScreen(session, options = {}) {
  if (!session || typeof session !== 'object') return null;
  if (session.vtScreen) return session.vtScreen;
  try {
    session.vtScreen = new SessionScreen({
      sessionId: session.id,
      ...options,
      // Read off the RECORD, not the caller: the restore fact belongs to the record and must
      // survive every later generation on it, so no call site can forget to pass it.
      restoredRecord: session.vtRestored === true,
    });
  } catch (error) {
    session.vtScreen = null;
  }
  return session.vtScreen || null;
}

function rotateSessionScreen(session, cause, options = {}) {
  if (!session || typeof session !== 'object') return null;
  if (!session.vtScreen) return ensureSessionScreen(session, { cause, ...options });
  try {
    session.vtScreen.newGeneration(cause, {
      ...options,
      restoredRecord: session.vtRestored === true,
    });
  } catch (error) { /* the previous generation stays; the frame reports what it can */ }
  return session.vtScreen;
}

function noteSessionOutput(session, data, meta) {
  if (!session || !session.vtScreen) return;
  try { session.vtScreen.noteOutput(data, meta); } catch (error) { /* observation only */ }
}

function noteSessionGeometry(session, geo) {
  if (!session || !session.vtScreen) return;
  try { session.vtScreen.noteGeometry(geo); } catch (error) { /* observation only */ }
}

function noteSessionDropped(session, drop) {
  if (!session || !session.vtScreen) return;
  try { session.vtScreen.noteDropped(drop); } catch (error) { /* observation only */ }
}

function disposeSessionScreen(session) {
  if (!session || !session.vtScreen) return;
  try { session.vtScreen.dispose(); } catch (error) { /* dropping the reference is the point */ }
  session.vtScreen = null;
}

/**
 * Read the observation frame for a session record. Returns the §9 `unavailable` frame — never
 * null, never a throw — when the session has no VT at all, which is what an old daemon's absent
 * route degrades to on the consumer side.
 */
async function readSessionFrame(session, options = {}) {
  const sessionId = session && session.id ? session.id : (options.sessionId || '');
  if (!session || !session.vtScreen) {
    const restored = Boolean(session && session.vtRestored === true);
    return {
      session_id: sessionId,
      unit: UNIT_NAME,
      observation_basis: 'unavailable',
      degraded_reasons: restored
        ? ['no_vt_observation', 'restored_no_vt_state']
        : ['no_vt_observation'],
      completeness: restored ? 'partial_since_restore' : 'partial_since_attach',
      vt_generation: 0,
      generation_cause: restored ? 'restored' : 'attached_mid_stream',
      frame_seq: 0,
      applied_units: 0,
      observed_units: 0,
      lag_units: 0,
      freshness: options.ownerDisconnected === true ? 'stale_owner_disconnected' : 'lagging',
      continuity: 'unverified',
      stream_id: null,
      dropped_units: 0,
      cols: null,
      rows: null,
      geometry_source: 'unverified',
      screen_kind: null,
      cursor: null,
      rows_text: [],
      snapshot_bytes: 0,
      snapshot_truncated: false,
    };
  }
  return session.vtScreen.readFrame(options);
}

module.exports = {
  SessionScreen,
  VT_LIMITS,
  UNIT_NAME,
  GENERATION_CAUSES,
  ensureSessionScreen,
  rotateSessionScreen,
  noteSessionOutput,
  noteSessionGeometry,
  noteSessionDropped,
  disposeSessionScreen,
  readSessionFrame,
  __setTerminalCtorForTest,
};
