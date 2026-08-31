# Daily Day Nav

Navigate to the previous or next calendar daily note, even when that day has no note yet.

## Why

The core **Daily notes** feature focuses on today. When you skip days in your journal, moving to yesterday or tomorrow often means manually creating missing notes first. Daily Day Nav jumps by calendar day and creates the note from your configured template when needed.

## Commands

| Command | Description |
| --- | --- |
| **Open previous daily note** | Opens the previous calendar day |
| **Open next daily note** | Opens the next calendar day |

If the target note does not exist yet, it is created using your Daily notes folder, format, and template settings.

Date formats containing subfolders, such as `YYYY/MM/YYYY-MM-DD`, are fully supported: notes are found and created inside the matching year/month folders, which are created automatically when missing.

## Hotkeys

1. Open **Settings → Hotkeys**
2. Search for `Open previous daily note` or `Open next daily note`
3. Assign your preferred shortcuts

## Requirements

- The core **Daily notes** plugin must be enabled
- A daily notes folder must be configured in Obsidian settings

## Installation

### From Community Plugins

1. Open **Settings → Community plugins**
2. Search for **Daily Day Nav**
3. Install and enable the plugin

### Manual installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/AntoineArt/obsidian-daily-day-nav/releases/latest)
2. Copy them to `.obsidian/plugins/daily-day-nav/` in your vault
3. Enable the plugin in **Settings → Community plugins**

## Development

```bash
npm install
npm run lint
```

## Releasing

1. Update `version` in `manifest.json` and `package.json`
2. Commit and push to `main`
3. Create and push a matching tag:

```bash
git tag 1.0.4
git push origin 1.0.4
```

GitHub Actions validates the plugin, attests release assets, and publishes the release.

Community submission is handled through the [Obsidian Community developer dashboard](https://community.obsidian.md).

## License

MIT
