"use strict";

const {
  Plugin,
  Notice,
  normalizePath,
  TFile,
  TFolder,
  Vault,
} = require("obsidian");

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
  onload() {
    this.addCommand({
      id: "open-previous-daily",
      name: "Open previous daily note",
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
    const dir = joinPath(...parts);
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
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
    const filename = date.format(this.getFilenameFormat(settings));
    const path = normalizePath(joinPath(settings.folder, `${filename}.md`));
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
