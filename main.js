"use strict";

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Platform,
  Notice,
  normalizePath,
  TFile,
  TFolder,
  Vault,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  threeFingerSwipe: true,
  singleFingerSwipe: true,
  swipeDownDismissKeyboard: true,
  holdHotkeyToRepeat: true,
};

const SWIPE_FINGER_COUNT = 3;
const SINGLE_SWIPE_EDGE_FRACTION = 0.05;
// Claim on the first meaningful horizontal move so Obsidian's sidebar
// drag never sees the gesture start (otherwise the sidebar "peeks").
const SINGLE_SWIPE_CLAIM_DISTANCE = 3;
// Don't judge the swipe's direction until the finger has travelled this
// far: the first couple of move events are too jittery to trust.
const SINGLE_SWIPE_LOCK_DISTANCE = 12;
// Once locked, the swipe counts as horizontal while dx beats dy by this
// ratio (~35 degrees of drift either way).
const SINGLE_SWIPE_HORIZONTAL_RATIO = 1.5;

// Claim a downward drag early enough that Obsidian's pull-down command
// palette never sees it; dismiss once the drag is clearly deliberate.
const KEYBOARD_SWIPE_CLAIM_DISTANCE = 12;
const KEYBOARD_SWIPE_DISMISS_DISTANCE = 30;
// Top fraction of the visible (above-keyboard) viewport left free for
// scrolling; swipes starting below it dismiss the keyboard.
const KEYBOARD_SWIPE_SCROLL_FRACTION = 0.4;

// Minimum height the keyboard must take from the screen before the
// viewport heuristic counts it as shown (status/nav bars are smaller).
const KEYBOARD_MIN_HEIGHT = 150;

const SWIPE_MIN_DISTANCE = 80;
const SWIPE_MAX_DURATION_MS = 1500;
const SWIPE_COOLDOWN_MS = 500;

// Obsidian's hotkey system does not re-fire commands on OS key-repeat, so
// holding the daily-note-navigation hotkey normally does nothing after the
// first press. Our own repeat loop (see registerHoldHotkeyToRepeat) drives
// navigation instead, pacing it with these: once the hold is confirmed it
// repeats at the start interval and ramps to the fastest one over RAMP_MS.
const HOLD_REPEAT_START_INTERVAL_MS = 260;
const HOLD_REPEAT_FASTEST_INTERVAL_MS = 120;
const HOLD_REPEAT_RAMP_MS = 1300;
// Obsidian can fire the hotkey's command a few tens of ms before *or*
// after the DOM keydown reaches us; the two are paired if within this.
const HOLD_REPEAT_ASSOCIATION_WINDOW_MS = 250;
// How often to check whether the OS auto-repeat stream has started.
const HOLD_REPEAT_POLL_MS = 40;
// A hold only counts once the OS starts auto-repeating the key (so a quick
// tap never double-navigates); give up waiting for that after this long.
const HOLD_REPEAT_FIRST_REPEAT_GRACE_MS = 1500;
// Once repeating, the key is considered released when no auto-repeat
// keydown has arrived for this long (macOS repeats every ~85ms).
const HOLD_REPEAT_HEARTBEAT_MS = 400;
// Absolute backstop: stop repeating after this long no matter what.
const HOLD_REPEAT_MAX_DURATION_MS = 15000;

// Physical keys we never treat as "the" hotkey - only as something held
// alongside it - when figuring out which key is driving a hold-repeat.
const HOLD_REPEAT_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

const joinPath = (...segments) => {
  const parts = [];
  for (const segment of segments) {
    parts.push(...segment.split("/"));
  }
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    normalized.push(part);
  }
  if (segments[0] === "" || segments[0]?.startsWith("/")) {
    normalized.unshift("");
  }
  return normalized.join("/");
};

// The element that owns the on-screen keyboard, or null when it is hidden.
const focusedEditable = () => {
  const el = document.activeElement;
  if (!el || el === document.body) {
    return null;
  }
  if (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA"
  ) {
    return el;
  }
  return null;
};

const getDateUID = (date, granularity = "day") => {
  const ts = date.clone().startOf(granularity).format();
  return `${granularity}-${ts}`;
};

module.exports = class DailyDayNavPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DailyDayNavSettingTab(this.app, this));

    if (Platform.isMobile) {
      this.trackActiveDailyNote();
      this.trackKeyboard();
      this.registerSwipeGesture();
      this.registerSingleFingerSwipe();
      this.registerKeyboardDismissSwipe();
    }

    this.holdRepeatState = {
      hold: null,
      lastPress: null,
      lastCommand: null,
      suppressed: new Set(),
    };
    this.registerHoldHotkeyToRepeat();

    this.addCommand({
      id: "open-previous-daily",
      name: "Open previous daily note",
      icon: "chevron-left",
      checkCallback: (checking) => {
        if (checking) {
          return this.canNavigateDailyNotes();
        }
        this.triggerDailyNav(-1);
        return true;
      },
    });

    this.addCommand({
      id: "open-next-daily",
      name: "Open next daily note",
      icon: "chevron-right",
      checkCallback: (checking) => {
        if (checking) {
          return this.canNavigateDailyNotes();
        }
        this.triggerDailyNav(1);
        return true;
      },
    });

    this.addRibbonIcon("chevron-left", "Previous daily note", () => {
      void this.openDailyForOffset(-1);
    });

    this.addRibbonIcon("chevron-right", "Next daily note", () => {
      void this.openDailyForOffset(1);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Makes holding the previous/next daily-note hotkey keep navigating
  // instead of requiring a fresh press each time.
  //
  // What the developer-console log showed on macOS, and what this design
  // leans on:
  //   - Obsidian fires the hotkey's command through a path that can beat
  //     the DOM keydown to us by tens of ms (or trail it), so the two are
  //     paired by time in either order rather than assuming one is first.
  //   - Obsidian ignores OS auto-repeat, but the repeat keydowns still
  //     reach us (~every 85ms) for exactly as long as the key is
  //     physically down - even with Cmd held, when Chromium sends no keyup
  //     for the key at all. That stream is the "still held" signal: we
  //     don't start repeating until the first repeat confirms a real hold
  //     (so a quick tap never double-navigates), and we stop as soon as it
  //     goes quiet.
  //   - If the modifier is let go first, the same repeats keep coming for
  //     the bare key (now typing "]" / "}"); the hold ends on the modifier
  //     change and those repeats are swallowed until the key's keyup or a
  //     fresh (non-repeat) press.
  registerHoldHotkeyToRepeat() {
    const state = this.holdRepeatState;

    this.registerDomEvent(
      window,
      "keydown",
      (event) => {
        const code = event.code;
        if (HOLD_REPEAT_MODIFIER_CODES.has(code)) {
          return;
        }
        const hold = state.hold;

        if (event.repeat) {
          if (hold && hold.code === code) {
            if (this.modifiersMatch(hold.mods, event)) {
              hold.sawRepeat = true;
              hold.lastRepeatAt = Date.now();
            } else {
              // Modifier released while the key stayed down: the OS is
              // now re-reporting the bare key as plain typing.
              this.stopHold();
              state.suppressed.add(code);
            }
            event.preventDefault();
            return;
          }
          if (state.suppressed.has(code)) {
            event.preventDefault();
          }
          return;
        }

        // A fresh press of this key.
        state.suppressed.delete(code);
        if (hold && hold.code === code) {
          this.stopHold();
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
          state.lastPress = {
            code,
            time: Date.now(),
            mods: this.modifiersOf(event),
          };
          this.tryStartHold();
        }
      },
      { capture: true }
    );

    this.registerDomEvent(
      window,
      "keyup",
      (event) => {
        const code = event.code;
        state.suppressed.delete(code);
        const hold = state.hold;
        if (!hold) {
          return;
        }
        if (hold.code === code) {
          this.stopHold();
        } else if (HOLD_REPEAT_MODIFIER_CODES.has(code)) {
          // The bare key may still be down and about to type; swallow it.
          state.suppressed.add(hold.code);
          this.stopHold();
        }
      },
      { capture: true }
    );

    this.registerDomEvent(window, "blur", () => {
      state.suppressed.clear();
      state.lastPress = null;
      state.lastCommand = null;
      this.stopHold();
    });
  }

  modifiersOf(event) {
    return {
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    };
  }

  modifiersMatch(mods, event) {
    return (
      mods.meta === event.metaKey &&
      mods.ctrl === event.ctrlKey &&
      mods.alt === event.altKey &&
      mods.shift === event.shiftKey
    );
  }

  triggerDailyNav(offset) {
    void this.openDailyForOffset(offset);

    if (!this.settings.holdHotkeyToRepeat) {
      return;
    }
    this.holdRepeatState.lastCommand = { offset, time: Date.now() };
    this.tryStartHold();
  }

  // Pairs the most recent hotkey command with the most recent
  // modifier+key press if they happened close together, in either order.
  tryStartHold() {
    const state = this.holdRepeatState;
    const { lastCommand, lastPress } = state;
    if (state.hold || !lastCommand || !lastPress) {
      return;
    }
    if (
      Math.abs(lastCommand.time - lastPress.time) >
      HOLD_REPEAT_ASSOCIATION_WINDOW_MS
    ) {
      return;
    }
    state.lastCommand = null;
    state.lastPress = null;
    this.startHold(lastPress.code, lastCommand.offset, lastPress.mods);
  }

  startHold(code, offset, mods) {
    const state = this.holdRepeatState;
    const hold = {
      code,
      offset,
      mods,
      startTime: Date.now(),
      repeatingSince: 0,
      sawRepeat: false,
      lastRepeatAt: 0,
      timer: null,
    };
    state.hold = hold;

    // True while the key still counts as held: the hold hasn't been
    // stopped, hasn't hit the cap, and either the OS repeat stream hasn't
    // had time to start yet or it's still flowing.
    const stillHeld = () => {
      if (state.hold !== hold) {
        return false;
      }
      const now = Date.now();
      if (now - hold.startTime >= HOLD_REPEAT_MAX_DURATION_MS) {
        return false;
      }
      if (!hold.sawRepeat) {
        return now - hold.startTime < HOLD_REPEAT_FIRST_REPEAT_GRACE_MS;
      }
      return now - hold.lastRepeatAt < HOLD_REPEAT_HEARTBEAT_MS;
    };

    const tick = () => {
      if (!stillHeld()) {
        if (state.hold === hold) {
          state.hold = null;
        }
        return;
      }
      if (!hold.sawRepeat) {
        // Not yet confirmed as a real hold: keep polling until the OS
        // repeat stream starts (or the grace period runs out).
        hold.timer = window.setTimeout(tick, HOLD_REPEAT_POLL_MS);
        return;
      }
      if (!hold.repeatingSince) {
        hold.repeatingSince = Date.now();
      }
      void this.openDailyForOffset(offset);

      const elapsed = Date.now() - hold.repeatingSince;
      const progress = Math.min(1, elapsed / HOLD_REPEAT_RAMP_MS);
      const interval =
        HOLD_REPEAT_START_INTERVAL_MS -
        (HOLD_REPEAT_START_INTERVAL_MS - HOLD_REPEAT_FASTEST_INTERVAL_MS) *
          progress;
      hold.timer = window.setTimeout(tick, interval);
    };
    hold.timer = window.setTimeout(tick, HOLD_REPEAT_POLL_MS);
  }

  stopHold() {
    const state = this.holdRepeatState;
    const hold = state.hold;
    if (!hold) {
      return;
    }
    window.clearTimeout(hold.timer);
    state.hold = null;
  }

  trackActiveDailyNote() {
    this.activeFileIsDaily = false;

    const update = async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        this.activeFileIsDaily = false;
        return;
      }
      const settings = await this.getDailyNotesSettings();
      if (!settings.folder) {
        this.activeFileIsDaily = false;
        return;
      }
      const folderPath = normalizePath(settings.folder);
      if (!file.path.startsWith(folderPath + "/")) {
        this.activeFileIsDaily = false;
        return;
      }
      const parsed = window.moment(
        file.basename,
        this.getFilenameFormat(settings),
        true
      );
      this.activeFileIsDaily = parsed.isValid();
    };

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void update())
    );
    this.app.workspace.onLayoutReady(() => void update());
  }

  trackKeyboard() {
    // Capacitor's Keyboard plugin broadcasts these on window; focus alone
    // is not reliable because Obsidian can keep the editor focused with
    // the keyboard hidden.
    this.keyboardShown = false;
    for (const name of ["keyboardWillShow", "keyboardDidShow"]) {
      this.registerDomEvent(window, name, () => {
        this.keyboardShown = true;
      });
    }
    for (const name of ["keyboardWillHide", "keyboardDidHide"]) {
      this.registerDomEvent(window, name, () => {
        this.keyboardShown = false;
      });
    }
  }

  isKeyboardVisible() {
    if (!focusedEditable()) {
      return false;
    }
    if (this.keyboardShown) {
      return true;
    }
    // Fallback when the keyboard events never fired: the keyboard eats a
    // large slice of the screen, shrinking either the window itself
    // (native resize) or the visual viewport (overlay).
    const viewport = window.visualViewport;
    const visible = Math.min(
      window.innerHeight,
      viewport?.height ?? Infinity
    );
    return window.screen.height - visible >= KEYBOARD_MIN_HEIGHT;
  }

  registerSingleFingerSwipe() {
    let gesture = null;
    let lastSwipeAt = 0;

    const reset = () => {
      gesture = null;
    };

    this.registerDomEvent(
      document,
      "touchstart",
      (event) => {
        // Only while the keyboard is up: with it hidden a horizontal drag
        // is far more likely to be text selection than navigation.
        if (
          !this.settings.singleFingerSwipe ||
          !this.activeFileIsDaily ||
          event.touches.length !== 1 ||
          !this.isKeyboardVisible()
        ) {
          reset();
          return;
        }
        const touch = event.touches[0];
        // Ignore touches on the mobile toolbar/navbar so scrolling the
        // toolbar horizontally doesn't trigger day navigation.
        if (
          event.target instanceof Element &&
          event.target.closest(".mobile-toolbar, .mobile-navbar")
        ) {
          reset();
          return;
        }
        const width = window.innerWidth;
        const edge = width * SINGLE_SWIPE_EDGE_FRACTION;
        // Leave the outer edges to Obsidian's sidebar swipe.
        if (touch.clientX < edge || touch.clientX > width - edge) {
          reset();
          return;
        }
        gesture = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          x: touch.clientX,
          y: touch.clientY,
          startTime: Date.now(),
          claimed: false,
        };
      },
      { capture: true, passive: true }
    );

    this.registerDomEvent(
      document,
      "touchmove",
      (event) => {
        if (!gesture) {
          return;
        }
        const touch = [...event.changedTouches].find(
          (t) => t.identifier === gesture.id
        );
        if (!touch) {
          return;
        }
        gesture.x = touch.clientX;
        gesture.y = touch.clientY;

        if (!gesture.claimed) {
          const dx = Math.abs(gesture.x - gesture.startX);
          const dy = Math.abs(gesture.y - gesture.startY);
          if (Math.max(dx, dy) >= SINGLE_SWIPE_LOCK_DISTANCE) {
            if (dx < dy * SINGLE_SWIPE_HORIZONTAL_RATIO) {
              // Vertical intent: this is a scroll, stay out of the way.
              reset();
              return;
            }
            gesture.claimed = true;
          } else if (dx < SINGLE_SWIPE_CLAIM_DISTANCE || dx < dy) {
            // Still inside the dead zone and not leaning horizontal yet.
            return;
          }
          // Leaning horizontal but not yet locked: swallow the move so the
          // sidebar drag can't start, but keep watching the direction.
        }
        event.stopPropagation();
      },
      { capture: true, passive: true }
    );

    this.registerDomEvent(document, "touchcancel", reset, {
      capture: true,
      passive: true,
    });

    this.registerDomEvent(
      document,
      "touchend",
      (event) => {
        if (!gesture) {
          return;
        }
        const touch = [...event.changedTouches].find(
          (t) => t.identifier === gesture.id
        );
        if (!touch) {
          return;
        }

        const finished = gesture;
        reset();

        if (!finished.claimed) {
          return;
        }
        event.stopPropagation();

        const dx = touch.clientX - finished.startX;
        const dy = touch.clientY - finished.startY;
        if (
          Math.abs(dx) >= SWIPE_MIN_DISTANCE &&
          Math.abs(dx) >= Math.abs(dy) * SINGLE_SWIPE_HORIZONTAL_RATIO &&
          Date.now() - finished.startTime <= SWIPE_MAX_DURATION_MS &&
          Date.now() - lastSwipeAt >= SWIPE_COOLDOWN_MS
        ) {
          lastSwipeAt = Date.now();
          void this.openDailyForOffset(dx > 0 ? -1 : 1);
        }
      },
      { capture: true, passive: true }
    );
  }

  registerKeyboardDismissSwipe() {
    let gesture = null;

    const reset = () => {
      gesture = null;
    };

    const hideKeyboard = (el) => {
      el?.blur?.();
      // Belt and braces: ask the OS keyboard to go away too.
      window.Capacitor?.Plugins?.Keyboard?.hide?.();
    };

    this.registerDomEvent(
      document,
      "touchstart",
      (event) => {
        const editable = focusedEditable();
        if (
          !this.settings.swipeDownDismissKeyboard ||
          !editable ||
          event.touches.length !== 1
        ) {
          reset();
          return;
        }
        const touch = event.touches[0];
        // Measure against the visual viewport (the area above the
        // keyboard), not the full window: with the keyboard up, half the
        // window can be keyboard, leaving almost no active zone.
        const viewport = window.visualViewport;
        const visibleTop = viewport?.offsetTop ?? 0;
        const visibleHeight = viewport?.height ?? window.innerHeight;
        // The top of the visible area stays free for scrolling.
        if (
          touch.clientY <
          visibleTop + visibleHeight * KEYBOARD_SWIPE_SCROLL_FRACTION
        ) {
          reset();
          return;
        }
        // The pull-down palette only fires with the note scrolled to the
        // top; that is the only case where we must eat the events.
        const scroller = editable.closest?.(".cm-editor")?.querySelector(
          ".cm-scroller"
        );
        gesture = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          atTop: scroller ? scroller.scrollTop <= 0 : false,
          editable,
          claimed: false,
          dismissed: false,
        };
      },
      { capture: true, passive: true }
    );

    this.registerDomEvent(
      document,
      "touchmove",
      (event) => {
        if (!gesture) {
          return;
        }
        const touch = [...event.changedTouches].find(
          (t) => t.identifier === gesture.id
        );
        if (!touch) {
          return;
        }
        const dx = touch.clientX - gesture.startX;
        const dy = touch.clientY - gesture.startY;

        if (!gesture.claimed) {
          if (Math.abs(dx) > Math.abs(dy) || dy < 0) {
            // Horizontal or upward intent: not a keyboard dismissal.
            reset();
            return;
          }
          if (dy >= KEYBOARD_SWIPE_CLAIM_DISTANCE) {
            gesture.claimed = true;
          }
        }
        if (!gesture.claimed) {
          return;
        }

        event.stopPropagation();
        if (gesture.atTop && event.cancelable) {
          // At the top a downward drag can only rubber-band, which is
          // what triggers the palette; cancel it outright.
          event.preventDefault();
        }
        if (!gesture.dismissed && dy >= KEYBOARD_SWIPE_DISMISS_DISTANCE) {
          gesture.dismissed = true;
          hideKeyboard(gesture.editable);
        }
      },
      { capture: true, passive: false }
    );

    this.registerDomEvent(document, "touchcancel", reset, {
      capture: true,
      passive: true,
    });

    this.registerDomEvent(
      document,
      "touchend",
      (event) => {
        if (!gesture) {
          return;
        }
        const touch = [...event.changedTouches].find(
          (t) => t.identifier === gesture.id
        );
        if (!touch) {
          return;
        }
        const finished = gesture;
        reset();
        if (finished.claimed) {
          event.stopPropagation();
        }
      },
      { capture: true, passive: true }
    );
  }

  registerSwipeGesture() {
    let gesture = null;
    let lastSwipeAt = 0;

    const reset = () => {
      gesture = null;
    };

    this.registerDomEvent(
      document,
      "touchstart",
      (event) => {
        if (!this.settings.threeFingerSwipe) {
          reset();
          return;
        }
        if (event.touches.length !== SWIPE_FINGER_COUNT) {
          // A fourth finger, or fewer touches, is not our gesture.
          reset();
          return;
        }
        gesture = {
          startTime: Date.now(),
          touches: new Map(
            [...event.touches].map((t) => [
              t.identifier,
              { startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY },
            ])
          ),
        };
      },
      { passive: true }
    );

    this.registerDomEvent(
      document,
      "touchmove",
      (event) => {
        if (!gesture) {
          return;
        }
        for (const t of event.changedTouches) {
          const tracked = gesture.touches.get(t.identifier);
          if (tracked) {
            tracked.x = t.clientX;
            tracked.y = t.clientY;
          }
        }
      },
      { passive: true }
    );

    this.registerDomEvent(document, "touchcancel", reset, { passive: true });

    this.registerDomEvent(
      document,
      "touchend",
      (event) => {
        if (!gesture) {
          return;
        }
        for (const t of event.changedTouches) {
          const tracked = gesture.touches.get(t.identifier);
          if (tracked) {
            tracked.x = t.clientX;
            tracked.y = t.clientY;
            tracked.done = true;
          }
        }
        if (event.touches.length > 0) {
          return;
        }

        const finished = gesture;
        reset();

        const deltas = [...finished.touches.values()].map((t) => ({
          dx: t.x - t.startX,
          dy: t.y - t.startY,
          done: t.done === true,
        }));

        if (
          deltas.length !== SWIPE_FINGER_COUNT ||
          !deltas.every((d) => d.done) ||
          Date.now() - finished.startTime > SWIPE_MAX_DURATION_MS ||
          Date.now() - lastSwipeAt < SWIPE_COOLDOWN_MS
        ) {
          return;
        }

        const sameDirection = deltas.every(
          (d) => Math.sign(d.dx) === Math.sign(deltas[0].dx)
        );
        const farEnough = deltas.every(
          (d) => Math.abs(d.dx) >= SWIPE_MIN_DISTANCE
        );
        const mostlyHorizontal = deltas.every(
          (d) => Math.abs(d.dx) > Math.abs(d.dy) * 2
        );

        if (sameDirection && farEnough && mostlyHorizontal) {
          lastSwipeAt = Date.now();
          void this.openDailyForOffset(deltas[0].dx > 0 ? -1 : 1);
        }
      },
      { passive: true }
    );
  }

  getDailyNotesPlugin() {
    const internal = this.app.internalPlugins;
    if (typeof internal.getPluginById === "function") {
      return internal.getPluginById("daily-notes");
    }
    return internal.plugins?.["daily-notes"] ?? null;
  }

  canNavigateDailyNotes() {
    return true;
  }

  async getDailyNotesSettings() {
    const periodic = this.app.plugins.getPlugin("periodic-notes");
    const periodicDaily = periodic?.settings?.daily;
    if (periodicDaily?.enabled) {
      return {
        folder: (periodicDaily.folder || "").trim(),
        format: periodicDaily.format || "YYYY-MM-DD",
        template: (periodicDaily.template || "").trim(),
      };
    }

    const options = this.getDailyNotesPlugin()?.instance?.options ?? {};
    if (options.folder) {
      return {
        folder: options.folder,
        format: options.format || "YYYY-MM-DD",
        template: options.template || "",
      };
    }

    try {
      const raw = await this.app.vault.adapter.read(
        `${this.app.vault.configDir}/daily-notes.json`
      );
      const json = JSON.parse(raw);
      return {
        folder: json.folder || "",
        format: json.format || "YYYY-MM-DD",
        template: json.template || "",
      };
    } catch {
      return { folder: "", format: "YYYY-MM-DD", template: "" };
    }
  }

  getFilenameFormat(settings) {
    return settings.format.split("/").pop();
  }

  getReferenceDate(settings) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return window.moment().startOf("day");
    }

    const folderPath = normalizePath(settings.folder);
    if (!file.path.startsWith(folderPath + "/")) {
      return window.moment().startOf("day");
    }

    const format = this.getFilenameFormat(settings);
    const parsed = window.moment(file.basename, format, true);
    return parsed.isValid()
      ? parsed.startOf("day")
      : window.moment().startOf("day");
  }

  getAllDailyNotes(settings) {
    const dailyNotes = {};
    const folderPath = normalizePath(settings.folder);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);

    if (!(folder instanceof TFolder)) {
      return dailyNotes;
    }

    const format = this.getFilenameFormat(settings);
    Vault.recurseChildren(folder, (note) => {
      if (!(note instanceof TFile)) {
        return;
      }
      const parsed = window.moment(note.basename, format, true);
      if (parsed.isValid()) {
        dailyNotes[getDateUID(parsed.startOf("day"), "day")] = note;
      }
    });

    return dailyNotes;
  }

  async ensureParentFolder(path) {
    const parts = path.replace(/\\/g, "/").split("/");
    parts.pop();
    if (!parts.length) {
      return;
    }
    let dir = "";
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(dir)) {
        try {
          await this.app.vault.createFolder(dir);
        } catch (error) {
          if (!this.app.vault.getAbstractFileByPath(dir)) {
            throw error;
          }
        }
      }
    }
  }

  async getTemplateContents(templateSetting) {
    if (!templateSetting) {
      return ["", null];
    }

    const templatePath = normalizePath(templateSetting);
    const templateFile =
      this.app.metadataCache.getFirstLinkpathDest(templatePath, "") ??
      this.app.vault.getAbstractFileByPath(
        templatePath.endsWith(".md") ? templatePath : `${templatePath}.md`
      );

    if (!(templateFile instanceof TFile)) {
      return ["", null];
    }

    try {
      const contents = await this.app.vault.cachedRead(templateFile);
      const foldInfo = this.app.foldManager.load(templateFile);
      return [contents, foldInfo];
    } catch (error) {
      console.error("Daily Day Nav: template read failed", error);
      new Notice("Could not read the daily note template.");
      return ["", null];
    }
  }

  applyTemplate(templateContents, date, settings) {
    const filename = date.format(this.getFilenameFormat(settings));
    const format = settings.format;

    return templateContents
      .replace(/\{\{\s*date\s*\}\}/gi, filename)
      .replace(/\{\{\s*time\s*\}\}/gi, window.moment().format("HH:mm"))
      .replace(/\{\{\s*title\s*\}\}/gi, filename)
      .replace(
        /\{\{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?\}\}/gi,
        (_, _token, calc, delta, unit, momentFormat) => {
          const now = window.moment();
          const currentDate = date.clone().set({
            hour: now.get("hour"),
            minute: now.get("minute"),
            second: now.get("second"),
          });
          if (calc) {
            currentDate.add(parseInt(delta, 10), unit);
          }
          if (momentFormat) {
            return currentDate.format(momentFormat.substring(1).trim());
          }
          return currentDate.format(format);
        }
      )
      .replace(
        /\{\{\s*yesterday\s*\}\}/gi,
        date.clone().subtract(1, "day").format(format)
      )
      .replace(
        /\{\{\s*tomorrow\s*\}\}/gi,
        date.clone().add(1, "day").format(format)
      );
  }

  async getDailyNotePath(date, settings) {
    const relativePath = date.format(settings.format);
    const path = normalizePath(joinPath(settings.folder, `${relativePath}.md`));
    await this.ensureParentFolder(path);
    return path;
  }

  async createDailyNoteForDate(date, settings) {
    const path = await this.getDailyNotePath(date, settings);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return existing;
    }

    const [templateContents, foldInfo] = await this.getTemplateContents(
      settings.template
    );
    const content = this.applyTemplate(templateContents, date, settings);

    try {
      const created = await this.app.vault.create(path, content);
      if (foldInfo) {
        this.app.foldManager.save(created, foldInfo);
      }
      return created;
    } catch (error) {
      const again = this.app.vault.getAbstractFileByPath(path);
      if (again instanceof TFile) {
        return again;
      }
      throw error;
    }
  }

  async openDailyNoteFile(file) {
    const leaf = this.app.workspace.getLeaf(false);

    await leaf.openFile(file, { active: true, focus: true });

    const active = this.app.workspace.getActiveFile();
    if (active?.path === file.path) {
      return;
    }

    await this.app.workspace.openLinkText(file.path, "", false);
  }

  async openDailyForOffset(dayOffset) {
    try {
      const settings = await this.getDailyNotesSettings();
      if (!settings.folder) {
        new Notice(
          "Configure a daily notes folder in Obsidian settings."
        );
        return;
      }

      const folder = this.app.vault.getAbstractFileByPath(
        normalizePath(settings.folder)
      );
      if (!(folder instanceof TFolder)) {
        new Notice(
          `Daily Day Nav: Folder not found: ${settings.folder}`
        );
        return;
      }

      const target = this.getReferenceDate(settings)
        .clone()
        .add(dayOffset, "day");
      const allNotes = this.getAllDailyNotes(settings);
      let file = allNotes[getDateUID(target, "day")] ?? null;

      if (!(file instanceof TFile)) {
        file = await this.createDailyNoteForDate(target, settings);
      }

      if (!(file instanceof TFile)) {
        new Notice(
          `Daily Day Nav: Could not open ${target.format(this.getFilenameFormat(settings))}.`
        );
        return;
      }

      await this.openDailyNoteFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Daily Day Nav: ${message}`);
      console.error("Daily Day Nav:", error);
    }
  }
};

class DailyDayNavSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Hold hotkey to repeat navigation")
      .setDesc(
        "Holding down the previous/next daily note hotkey keeps navigating, speeding up the longer you hold it."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.holdHotkeyToRepeat)
          .onChange(async (value) => {
            this.plugin.settings.holdHotkeyToRepeat = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Three-finger swipe navigation (mobile)")
      .setDesc(
        "Swipe left with three fingers to open the next daily note, right for the previous one."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.threeFingerSwipe)
          .onChange(async (value) => {
            this.plugin.settings.threeFingerSwipe = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Single-finger swipe in daily notes (mobile)")
      .setDesc(
        "While a daily note is open and the keyboard is showing, swiping in the middle 90% of the screen opens the next (left) or previous (right) daily note instead of the sidebars. Swipes starting in the outer 5% edges still open the sidebars."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.singleFingerSwipe)
          .onChange(async (value) => {
            this.plugin.settings.singleFingerSwipe = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Swipe down to dismiss keyboard (mobile)")
      .setDesc(
        "While typing, swiping down dismisses the on-screen keyboard instead of opening the pull-down command palette."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.swipeDownDismissKeyboard)
          .onChange(async (value) => {
            this.plugin.settings.swipeDownDismissKeyboard = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
