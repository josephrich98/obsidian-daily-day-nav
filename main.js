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
};

const SWIPE_FINGER_COUNT = 3;
const SINGLE_SWIPE_EDGE_FRACTION = 0.05;
// Claim on the first meaningful horizontal move so Obsidian's sidebar
// drag never sees the gesture start (otherwise the sidebar "peeks").
const SINGLE_SWIPE_CLAIM_DISTANCE = 3;

// Claim a downward drag early enough that Obsidian's pull-down command
// palette never sees it; dismiss once the drag is clearly deliberate.
const KEYBOARD_SWIPE_CLAIM_DISTANCE = 12;
const KEYBOARD_SWIPE_DISMISS_DISTANCE = 30;
// Top fraction of the visible (above-keyboard) viewport left free for
// scrolling; swipes starting below it dismiss the keyboard.
const KEYBOARD_SWIPE_SCROLL_FRACTION = 0.4;

const SWIPE_MIN_DISTANCE = 80;
const SWIPE_MAX_DURATION_MS = 1500;
const SWIPE_COOLDOWN_MS = 500;

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
      this.registerSwipeGesture();
      this.registerSingleFingerSwipe();
      this.registerKeyboardDismissSwipe();
    }

    this.addCommand({
      id: "open-previous-daily",
      name: "Open previous daily note",
      icon: "chevron-left",
      checkCallback: (checking) => {
        if (checking) {
          return this.canNavigateDailyNotes();
        }
        void this.openDailyForOffset(-1);
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
        void this.openDailyForOffset(1);
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
        if (
          !this.settings.singleFingerSwipe ||
          !this.activeFileIsDaily ||
          event.touches.length !== 1
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
          const dx = gesture.x - gesture.startX;
          const dy = gesture.y - gesture.startY;
          if (Math.abs(dy) > Math.abs(dx)) {
            // Vertical intent: this is a scroll, stay out of the way.
            reset();
            return;
          }
          if (Math.abs(dx) >= SINGLE_SWIPE_CLAIM_DISTANCE) {
            gesture.claimed = true;
          }
        }
        if (gesture.claimed) {
          event.stopPropagation();
        }
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
          Math.abs(dx) > Math.abs(dy) * 2 &&
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
        "While a daily note is open, swiping in the middle 90% of the screen opens the next (left) or previous (right) daily note instead of the sidebars. Swipes starting in the outer 5% edges still open the sidebars."
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
