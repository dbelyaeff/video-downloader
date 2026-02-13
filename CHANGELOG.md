# Changelog

All notable changes to this project will be documented in this file.

## [1.1.1] - 2026-02-13

### Added
- 📌 Display app version and GitHub repository link after the startup banner
- 📜 Disclaimer notice with localized link to Terms of Use (RU/EN)

### Changed
- 🔗 Removed platform-specific mentions (YouTube/VK) from the download URL prompt

### Fixed
- 🐛 Fixed version reading from `package.json` (replaced `import.meta.url` with `process.cwd()`)
- 📝 Fixed typo in `DISCLAIMER.RU.md` (corrupted text in section 2.3)

## [1.1.0] - 2026-02-13

### Added
- 🎨 Startup banner with ASCII art using `ANSI Shadow` font (figlet)
- 🖼️ Double-line frame around the banner with padding
- 📦 New dependencies: `figlet`, `picocolors`

### Fixed
- Export `DependencyPaths` interface from `dependencies.ts`
- Proper cancel handling for text inputs in settings
