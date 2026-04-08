# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-04-08

### Added
- ⚡ CLI mode: pass URL as argument to skip interactive menu (e.g., `vd https://...`)
- 📦 New dependency: `commander` for CLI argument parsing
- 🔗 `-q, --quality` - specify video quality (highest, 4K, 1080p, 720p, 480p, mp3)
- 📁 `-o, --output` - specify output directory
- 📄 `-f, --filename` - specify output filename
- 🖼️ `-c, --cover` - download cover image (jpg)
- 📝 `-d, --description` - download description to file
- 📋 `-D, --copy-description` - copy description to clipboard (Mac)
- 🔧 `--debug` - enable debug mode

### Changed
- 🎨 Refactored `main()` into separate `runInteractiveMode()` and `runCliMode()` functions
- 💻 Banner now displays in CLI mode as well

### Fixed
- 🐛 Fix CLI args parsing (moved `program.parse()` after main function)

## [1.1.2] - 2026-04-08

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
