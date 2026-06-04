"use strict";

const { Plugin, Notice, normalizePath, TFile } = require("obsidian");

module.exports = class DailyDayNavPlugin extends Plugin {
  onload() {
    this.addCommand({
      id: "open-previous-daily",
      name: "Open previous daily note",
      callback: () => {
        void this.openDailyForOffset(-1);
      },
    });

    this.addCommand({
      id: "open-next-daily",
      name: "Open next daily note",
      callback: () => {
        void this.openDailyForOffset(1);
      },
    });
  }

  async getDailyNotesSettings() {
    const core = this.app.internalPlugins.getPluginById("daily-notes");
    const options = core?.instance?.options ?? {};

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

  getReferenceDate(settings) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return window.moment().startOf("day");
    }

    const folderPath = normalizePath(settings.folder);
    if (!file.path.startsWith(folderPath + "/")) {
      return window.moment().startOf("day");
    }

    const parsed = window.moment(file.basename, settings.format, true);
    return parsed.isValid() ? parsed.startOf("day") : window.moment().startOf("day");
  }

  getDailyNotePath(date, settings) {
    const filename = date.format(settings.format);
    return normalizePath(`${settings.folder}/${filename}.md`);
  }

  async buildDailyNoteContent(date, settings) {
    if (!settings.template) {
      return "";
    }

    const templatePath = settings.template.endsWith(".md")
      ? settings.template
      : `${settings.template}.md`;
    const templateFile = this.app.vault.getAbstractFileByPath(
      normalizePath(templatePath)
    );

    if (!(templateFile instanceof TFile)) {
      return "";
    }

    const filename = date.format(settings.format);
    const content = await this.app.vault.read(templateFile);

    return content
      .replace(/\{\{date\}\}/gi, filename)
      .replace(/\{\{title\}\}/gi, filename)
      .replace(/\{\{time\}\}/gi, window.moment().format("HH:mm"));
  }

  async createDailyNoteForDate(date, settings) {
    const path = this.getDailyNotePath(date, settings);
    const content = await this.buildDailyNoteContent(date, settings);
    return this.app.vault.create(path, content);
  }

  async openDailyForOffset(dayOffset) {
    try {
      const core = this.app.internalPlugins.getPluginById("daily-notes");
      if (!core?.enabled) {
        new Notice("Enable the daily notes core plugin first.");
        return;
      }

      const settings = await this.getDailyNotesSettings();
      if (!settings.folder) {
        new Notice("Configure a daily notes folder in Obsidian settings first.");
        return;
      }

      const target = this.getReferenceDate(settings).clone().add(dayOffset, "day");
      const path = this.getDailyNotePath(target, settings);
      let file = this.app.vault.getAbstractFileByPath(path);

      if (!(file instanceof TFile)) {
        file = await this.createDailyNoteForDate(target, settings);
      }

      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
        return;
      }

      new Notice(`Could not open daily note for ${target.format(settings.format)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Daily Day Nav: ${message}`);
      console.error("Daily Day Nav:", error);
    }
  }
};
