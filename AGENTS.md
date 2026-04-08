# Development Notes

## After Making Changes

1. **Compile binary:**
   ```bash
   bun run build:macos-arm
   ```

2. **Update local version:**
   ```bash
   sudo rm /usr/local/bin/vd && sudo ln -s "$(pwd)/dist/video-downloader-macos-arm" /usr/local/bin/vd
   ```

3. **Test:**
   ```bash
   vd --help
   ```
