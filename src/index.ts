import { intro, outro, select, text, multiselect, log, spinner, isCancel } from '@clack/prompts';
import figlet from 'figlet';
import pc from 'picocolors';
import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, symlinkSync, copyFileSync, chmodSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { parse, stringify } from 'yaml';
import { homedir, platform } from 'os';
import { ensureDependencies, getYtDlpCommand, getFfmpegCommand, DependencyPaths } from './dependencies';
import { t, getSystemLanguage, setCurrentLanguage, AVAILABLE_LANGUAGES, Language, isValidLanguage, DEFAULT_LANGUAGE } from './i18n';
import { Command } from 'commander';

const program = new Command();

program
  .name('vd')
  .description('Video downloader CLI')
  .version('1.2.0')
  .argument('[url]', 'Video URL to download')
  .option('-q, --quality <quality>', 'Preferred quality (highest, 4K, 1080p, 720p, 480p, mp3)')
  .option('-o, --output <path>', 'Download output path')
  .option('-f, --filename <filename>', 'Output filename')
  .option('-c, --cover', 'Download cover image (jpg)')
  .option('-d, --description', 'Download description to file')
  .option('-D, --copy-description', 'Copy description to clipboard (Mac)')
  .option('--debug', 'Enable debug mode');

function expandPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return inputPath.replace(/^~/, homedir());
  }
  return inputPath;
}

interface Settings {
  defaultDownloadPath: string;
  defaultFilename: string;
  preferredQuality: string;
  downloadCover: boolean;
  downloadDescription: boolean;
  debug: boolean;
  browser: string;
  mp3Bitrate: number;
  language: Language;
}

interface VideoInfo {
  title: string;
  uploader: string;
  upload_date: string;
  description: string;
  thumbnail: string;
  webpage_url: string;
}

const SETTINGS_FILE = join(process.env.HOME || process.cwd(), '.video-downloader-settings.yaml');

const DEFAULT_SETTINGS: Settings = {
  defaultDownloadPath: '',
  defaultFilename: '',
  preferredQuality: 'highest',
  downloadCover: true,
  downloadDescription: true,
  debug: false,
  browser: '',
  mp3Bitrate: 128,
  language: getSystemLanguage(),
};

function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) {
    return DEFAULT_SETTINGS;
  }

  const content = readFileSync(SETTINGS_FILE, 'utf8');
  const settings = parse(content) as Settings;

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
  };
}

function saveSettings(settings: Settings): void {
  const content = stringify(settings);
  writeFileSync(SETTINGS_FILE, content, 'utf8');
}

async function askForLanguageOnFirstRun(settings: Settings): Promise<void> {
  // Если настройки уже существуют, не спрашиваем
  if (existsSync(SETTINGS_FILE)) {
    return;
  }

  // Определяем системный язык
  const systemLang = getSystemLanguage();

  // Если системный язык поддерживается, используем его
  if (systemLang !== 'en') {
    settings.language = systemLang;
    setCurrentLanguage(systemLang);
    return;
  }

  // Иначе спрашиваем пользователя
  const langChoice = await select<Language>({
    message: 'Select your language / Выберите язык:',
    options: [
      { label: 'English', value: 'en' },
      { label: 'Русский', value: 'ru' },
    ],
    initialValue: 'en',
  });

  if (!isCancel(langChoice) && isValidLanguage(langChoice)) {
    settings.language = langChoice;
    setCurrentLanguage(langChoice);
  }
}

async function getVideoInfo(url: string, debug: boolean, browser: string, depPaths: DependencyPaths): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['--dump-json'];
    if (browser) {
      args.push('--cookies-from-browser', browser);
    }
    args.push(url);

    const child = spawn(getYtDlpCommand(depPaths), args);

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
      if (debug || process.env.DEBUG === 'true') {
        console.error(`[yt-dlp stderr]: ${data.toString()}`);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          const videoInfo = JSON.parse(output);
          resolve(videoInfo);
        } catch (error) {
          if (debug || process.env.DEBUG === 'true') {
            console.error('Failed to parse output:', output);
          }
          reject(new Error('Failed to parse video information'));
        }
      } else {
        // Check for authentication required error
        if (errorOutput.includes('Sign in to confirm') ||
          errorOutput.includes('cookies-from-browser') ||
          errorOutput.includes('Use --cookies') ||
          errorOutput.includes('authentication')) {
          reject(new Error('AUTH_REQUIRED'));
        } else {
          const errorMsg = debug || process.env.DEBUG === 'true'
            ? `Failed to get video information: ${errorOutput}`
            : 'Failed to get video information';
          reject(new Error(errorMsg));
        }
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
    });

    // Add timeout to prevent hanging
    setTimeout(() => {
      child.kill();
      reject(new Error('yt-dlp timed out after 30 seconds'));
    }, 30000);
  });
}

async function getFormatSizes(url: string, browser: string, debug: boolean, depPaths: DependencyPaths): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const sizes = new Map<string, string>();
    const args: string[] = ['--list-formats', '--no-warnings'];
    if (browser) {
      args.push('--cookies-from-browser', browser);
    }
    args.push(url);

    const child = spawn(getYtDlpCommand(depPaths), args);
    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
      if (debug || process.env.DEBUG === 'true') {
        console.error(`[yt-dlp stderr]: ${data.toString()}`);
      }
    });

    child.on('close', () => {
      // Парсим вывод yt-dlp для получения размеров
      const lines = output.split('\n');
      let bestAudioSize: string | null = null;
      let bestAudioBytes: number = 0;

      for (const line of lines) {
        // Ищем строки с разрешением формата 640x360, 1280x720 и т.д. и размером файла
        const match = line.match(/(\d+)x(\d+)\s+.*?(\d+\.?\d*\s*(?:MiB|GiB|KiB))/i);
        if (match) {
          const height = parseInt(match[2]);
          const size = match[3].trim();

          let quality: string | null = null;
          if (height >= 2160) quality = '4K';
          else if (height >= 1080) quality = '1080p';
          else if (height >= 720) quality = '720p';
          else if (height >= 480) quality = '480p';

          if (quality && !sizes.has(quality)) {
            sizes.set(quality, size);
          }
        }

        // Ищем аудио-форматы (audio only)
        const audioMatch = line.match(/audio only.*?(\d+\.?\d*\s*(?:MiB|GiB|KiB))/i);
        if (audioMatch) {
          const sizeStr = audioMatch[1].trim();
          // Конвертируем в байты для сравнения
          const unitMultiplier: { [key: string]: number } = {
            'B': 1, 'KiB': 1024, 'MiB': 1024 ** 2, 'GiB': 1024 ** 3, 'TiB': 1024 ** 4,
            'KB': 1000, 'MB': 1000 ** 2, 'GB': 1000 ** 3, 'TB': 1000 ** 4
          };
          const sizeMatch = sizeStr.match(/(\d+\.?\d*)\s*(\w+)/);
          if (sizeMatch) {
            const sizeValue = parseFloat(sizeMatch[1]);
            const sizeUnit = sizeMatch[2];
            const sizeInBytes = sizeValue * (unitMultiplier[sizeUnit] || 1);

            // Берем аудио с наибольшим размером (лучшее качество)
            if (sizeInBytes > bestAudioBytes) {
              bestAudioBytes = sizeInBytes;
              bestAudioSize = sizeStr;
            }
          }
        }
      }

      // Добавляем размер аудио
      if (bestAudioSize) {
        sizes.set('mp3', bestAudioSize);
      }

      resolve(sizes);
    });

    child.on('error', () => {
      resolve(sizes);
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function createProgressBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function truncateTitle(title: string, maxLength: number = 75): string {
  if (title.length <= maxLength) {
    return title;
  }

  // Обрезаем до maxLength, но не разрываем слова
  const truncated = title.substring(0, maxLength);
  const lastSpaceIndex = truncated.lastIndexOf(' ');

  if (lastSpaceIndex > 0) {
    return truncated.substring(0, lastSpaceIndex) + '…';
  }

  return truncated + '…';
}

function formatQualityLabel(quality: string): string {
  const qualityUpper = quality.toUpperCase();
  // ANSI коды для жирного текста: \x1b[1m (включить) и \x1b[0m (выключить)
  return `\x1b[1m[${qualityUpper}]\x1b[0m`;
}

async function downloadSingleFile(
  videoInfo: VideoInfo,
  quality: string,
  filename: string,
  fullpath: string,
  totalSizeStr: string | undefined,
  options: {
    browser: string;
    debug: boolean;
    mp3Bitrate: number;
  },
  depPaths: DependencyPaths
): Promise<{ success: boolean; sizeMb: number; error?: string }> {
  const truncatedTitle = truncateTitle(videoInfo.title);
  const qualityLabel = formatQualityLabel(quality);
  const sizeLabel = totalSizeStr ? ` // ${totalSizeStr}` : '';

  log.info(`${qualityLabel} ${truncatedTitle}${sizeLabel}`);

  const args: string[] = ['--no-warnings', '--newline', '--progress'];

  if (options.browser) {
    args.push('--cookies-from-browser', options.browser);
  }

  if (quality === 'mp3') {
    // Для MP3: извлекаем аудио, добавляем метаданные и обложку
    args.push('--extract-audio', '--audio-format', 'mp3');
    args.push('--audio-quality', `${options.mp3Bitrate}K`);
    args.push('--embed-thumbnail');
    args.push('--add-metadata');
  } else {
    const height = quality === '4K' ? '2160' : quality === '1080p' ? '1080' : quality === '720p' ? '720' : '480';
    args.push('--format', `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`);
  }

  args.push('--output', fullpath);
  args.push(videoInfo.webpage_url);

  return new Promise((resolve) => {
    const child = spawn(getYtDlpCommand(depPaths), args);

    let downloadedBytes = 0;
    let totalBytes = 0;
    let lastTotalStr = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      const output = data.toString();

      // Парсим прогресс yt-dlp
      const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+(\d+\.?\d*)([KMGT]i?B)\s+at\s+([\d\.]+)([KMGT]i?B\/s)/);
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        const size = parseFloat(progressMatch[2]);
        const unit = progressMatch[3];
        const speed = parseFloat(progressMatch[4]);
        const speedUnit = progressMatch[5];

        // Конвертируем в байты для отображения
        const unitMultiplier: { [key: string]: number } = {
          'B': 1, 'KiB': 1024, 'MiB': 1024 ** 2, 'GiB': 1024 ** 3, 'TiB': 1024 ** 4,
          'KB': 1000, 'MB': 1000 ** 2, 'GB': 1000 ** 3, 'TB': 1000 ** 4
        };

        totalBytes = size * (unitMultiplier[unit] || 1);
        downloadedBytes = (percent / 100) * totalBytes;

        const downloadedStr = formatBytes(downloadedBytes);
        lastTotalStr = formatBytes(totalBytes);

        const progressBar = createProgressBar(percent);
        process.stdout.write(`\r${progressBar} ${percent.toFixed(1)}% | ${downloadedStr} / ${lastTotalStr} @ ${speed}${speedUnit}/s    `);
      }
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
      if (options.debug || process.env.DEBUG === 'true') {
        console.error(`[yt-dlp stderr]: ${data.toString()}`);
      }
    });

    child.on('close', async (code) => {
      process.stdout.write('\n');
      if (code === 0) {
        const fileSize = existsSync(fullpath) ? readFileSync(fullpath).byteLength : 0;
        const sizeMb = Math.round(fileSize / (1024 * 1024) * 100) / 100;
        log.success(`✅ ${filename} (${quality}) - ${formatBytes(fileSize)}`);
        resolve({ success: true, sizeMb });
      } else {
        log.error(`❌ Ошибка загрузки ${filename}`);
        resolve({ success: false, sizeMb: 0, error: errorOutput });
      }
    });
  });
}

async function downloadVideo(videoInfo: VideoInfo, options: {
  filename: string;
  downloadPath: string;
  qualities: string[];
  downloadCover: boolean;
  downloadDescription: boolean;
  debug: boolean;
  browser: string;
  formatSizes: Map<string, string>;
  mp3Bitrate: number;
}, depPaths: DependencyPaths): Promise<{ filename: string; quality: string; sizeMb: number }[]> {
  const results: { filename: string; quality: string; sizeMb: number }[] = [];
  const baseFilename = options.filename.replace(/\.mp4$/, '');

  // Сначала скачиваем видео
  for (const quality of options.qualities) {
    const filename = `${baseFilename}${quality === 'mp3' ? '' : `_${quality}`}${quality === 'mp3' ? '.mp3' : '.mp4'}`;
    const fullpath = join(options.downloadPath, filename);
    const totalSizeStr = options.formatSizes.get(quality);

    const result = await downloadSingleFile(videoInfo, quality, filename, fullpath, totalSizeStr, {
      browser: options.browser,
      debug: options.debug,
      mp3Bitrate: options.mp3Bitrate,
    }, depPaths);

    if (result.success) {
      results.push({
        filename,
        quality,
        sizeMb: result.sizeMb,
      });
    }
  }

  // Скачиваем обложку если нужно
  if (options.downloadCover) {
    const s = spinner();
    s.start('🖼️ ' + t('download.gettingVideoInfo'));

    const coverArgs: string[] = ['--write-thumbnail', '--skip-download', '--convert-thumbnails', 'jpg'];
    if (options.browser) {
      coverArgs.push('--cookies-from-browser', options.browser);
    }
    coverArgs.push('--output', join(options.downloadPath, baseFilename));
    coverArgs.push(videoInfo.webpage_url);

    await new Promise<void>((resolve) => {
      const child = spawn(getYtDlpCommand(depPaths), coverArgs);
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });

    s.stop(t('download.coverDownloaded'));
  }

  // Скачиваем описание если нужно
  if (options.downloadDescription) {
    const s = spinner();
    s.start('📝 ' + t('download.gettingVideoInfo'));

    const descArgs: string[] = ['--write-description', '--skip-download'];
    if (options.browser) {
      descArgs.push('--cookies-from-browser', options.browser);
    }
    descArgs.push('--output', join(options.downloadPath, baseFilename));
    descArgs.push(videoInfo.webpage_url);

    await new Promise<void>((resolve) => {
      const child = spawn(getYtDlpCommand(depPaths), descArgs);
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });

    s.stop(t('download.descriptionDownloaded'));
  }

  // Метаданные и обложка для MP3 добавляются автоматически yt-dlp через --embed-thumbnail --add-metadata

  return results;
}

async function main() {
  const args = program.args;
  const opts = program.opts();
  const urlFromArg = args[0];

  const settings = loadSettings();
  await askForLanguageOnFirstRun(settings);
  setCurrentLanguage(settings.language);

  const debugMode = opts.debug || settings.debug;

  if (urlFromArg) {
    await runCliMode(urlFromArg, opts, settings, debugMode);
  } else {
    await runInteractiveMode(settings);
  }
}

async function runInteractiveMode(settings: Settings): Promise<void> {
  console.clear();
  const font = 'ANSI Shadow';
  const text1 = figlet.textSync('Video', {
    font: font as any,
    horizontalLayout: 'default'
  });
  const text2 = figlet.textSync('Downloader', {
    font: font as any,
    horizontalLayout: 'default'
  });

  const lines1 = text1.split('\n');
  const lines2 = text2.split('\n');

  const maxWidth = Math.max(
    ...lines1.map(l => l.length),
    ...lines2.map(l => l.length)
  );

  // Add more padding inside the frame as requested
  const paddingX = 4;
  const paddingY = 1;
  const border = '═'.repeat(maxWidth + (paddingX * 2));

  console.log(pc.cyan(`╔${border}╗`));

  // Top padding
  for (let i = 0; i < paddingY; i++) {
    console.log(pc.cyan(`║${' '.repeat(maxWidth + (paddingX * 2))}║`));
  }

  [...lines1, ...lines2].forEach((line) => {
    // Calculate total space inside frame
    const totalSpace = maxWidth + (paddingX * 2);
    // Center the line
    const remainingSpace = totalSpace - line.length;
    const padLeft = Math.floor(remainingSpace / 2);
    const padRight = remainingSpace - padLeft;

    console.log(pc.cyan(`║${' '.repeat(padLeft)}${line}${' '.repeat(padRight)}║`));
  });

  // Bottom padding
  for (let i = 0; i < paddingY; i++) {
    console.log(pc.cyan(`║${' '.repeat(maxWidth + (paddingX * 2))}║`));
  }

  console.log(pc.cyan(`╚${border}╝`));

  // Version and GitHub link
  let appVersion = '0.0.0';
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    if (existsSync(pkgPath)) {
      const pkgData = JSON.parse(readFileSync(pkgPath, 'utf8'));
      appVersion = pkgData.version || appVersion;
    }
  } catch { }
  const githubUrl = 'https://github.com/dbelyaeff/video-downloader';
  const infoLine = `v${appVersion}  •  ${githubUrl}`;
  const frameWidth = maxWidth + (paddingX * 2) + 2; // +2 for the border chars
  const infoPadLeft = Math.max(0, Math.floor((frameWidth - infoLine.length) / 2));
  console.log(' '.repeat(infoPadLeft) + pc.dim(`v${appVersion}`) + pc.dim('  •  ') + pc.cyan(pc.underline(githubUrl)));

  // Disclaimer
  const currentLang = settings.language;
  const disclaimerUrl = currentLang === 'ru'
    ? 'https://github.com/dbelyaeff/video-downloader/blob/main/DISCLAIMER.RU.md'
    : 'https://github.com/dbelyaeff/video-downloader/blob/main/DISCLAIMER.EN.md';
  const disclaimerText = `${t('app.disclaimer')} ${t('app.termsOfUse')}`;
  const disclaimerPadLeft = Math.max(0, Math.floor((frameWidth - disclaimerText.length) / 2));
  console.log(' '.repeat(disclaimerPadLeft) + pc.dim(t('app.disclaimer') + ' ') + pc.yellow(pc.underline(t('app.termsOfUse'))));
  console.log(' '.repeat(disclaimerPadLeft) + pc.dim(disclaimerUrl));
  console.log();

  intro(t('app.title'));

  // Проверяем и устанавливаем зависимости
  const depPaths = await ensureDependencies();
  if (!depPaths) {
    outro(t('dependencies.initFailed'));
    process.exit(1);
  }

  // Dependencies are checked silently - only errors are shown

  while (true) {
    const mainMenu = await select<string>({
      message: t('common.selectOption'),
      options: [
        { label: t('menu.downloadVideo'), value: 'download' },
        { label: t('menu.settings'), value: 'settings' },
        { label: t('menu.exit'), value: 'exit' },
      ],
    });

    if (isCancel(mainMenu)) {
      break;
    }

    if (mainMenu === 'exit') {
      break;
    }

    if (mainMenu === 'settings') {
      await configureSettings(settings);
      continue;
    }

    if (mainMenu === 'download') {
      await downloadVideoFlow(settings, depPaths);
    }
  }

  outro('👋 ' + t('menu.exit'));
}

async function runCliMode(
  url: string,
  opts: {
    quality?: string;
    output?: string;
    filename?: string;
    cover?: boolean;
    description?: boolean;
    copyDescription?: boolean;
    debug?: boolean;
  },
  settings: Settings,
  debugMode: boolean
): Promise<void> {
  console.clear();
  const font = 'ANSI Shadow';
  const text1 = figlet.textSync('Video', { font: font as any, horizontalLayout: 'default' });
  const text2 = figlet.textSync('Downloader', { font: font as any, horizontalLayout: 'default' });

  const maxWidth = Math.max(...text1.split('\n').map(l => l.length), ...text2.split('\n').map(l => l.length));
  const paddingX = 4;
  const border = '═'.repeat(maxWidth + (paddingX * 2));

  console.log(pc.cyan(`╔${border}╗`));
  [...text1.split('\n'), ...text2.split('\n')].forEach((line) => {
    const remainingSpace = maxWidth + (paddingX * 2) - line.length;
    const padLeft = Math.floor(remainingSpace / 2);
    console.log(pc.cyan(`║${' '.repeat(padLeft)}${line}${' '.repeat(remainingSpace - padLeft)}║`));
  });
  console.log(pc.cyan(`╚${border}╝`));
  console.log();

  const depPaths = await ensureDependencies();
  if (!depPaths) {
    outro(t('dependencies.initFailed'));
    process.exit(1);
  }

  const s = spinner();
  s.start(t('download.gettingVideoInfo'));

  try {
    const videoInfo = await getVideoInfo(url, debugMode, settings.browser, depPaths);
    s.stop(t('common.success'));

    if (!videoInfo) {
      log.error(t('common.error', { message: 'Video info is empty' }));
      process.exit(1);
    }

    const downloadPath = expandPath(opts.output || settings.defaultDownloadPath || process.cwd());
    const filename = opts.filename || settings.defaultFilename || videoInfo.title || 'video';
    const quality = opts.quality || settings.preferredQuality;
    const qualities = quality === 'highest' ? ['1080p'] : [quality];
    const downloadCover = opts.cover || settings.downloadCover;
    const downloadDescription = opts.description || settings.downloadDescription;
    const copyDescription = opts.copyDescription;

    log.info('');
    log.info(t('download.videoTitle', { title: videoInfo.title || 'N/A' }));
    log.info('');

    if (copyDescription && videoInfo.description) {
      try {
        const echo = spawn('echo', [videoInfo.description]);
        const pbcopy = spawn('pbcopy');
        echo.stdout.pipe(pbcopy.stdin);
        await new Promise<void>((resolve) => {
          pbcopy.on('close', () => resolve());
          pbcopy.on('error', () => resolve());
        });
        log.success(t('download.descriptionCopied'));
      } catch {
        log.error('Failed to copy to clipboard');
      }
    }

    const formatSizes = await getFormatSizes(url, settings.browser, debugMode, depPaths);

    const qualityOptions: { label: string; value: string }[] = [];
    if (formatSizes.has('4K')) qualityOptions.push({ label: `4K (${formatSizes.get('4K')})`, value: '4K' });
    if (formatSizes.has('1080p')) qualityOptions.push({ label: `1080p (${formatSizes.get('1080p')})`, value: '1080p' });
    if (formatSizes.has('720p')) qualityOptions.push({ label: `720p (${formatSizes.get('720p')})`, value: '720p' });
    if (formatSizes.has('480p')) qualityOptions.push({ label: `480p (${formatSizes.get('480p')})`, value: '480p' });
    if (formatSizes.has('mp3')) qualityOptions.push({ label: `${t('qualities.mp3')} (${formatSizes.get('mp3')})`, value: 'mp3' });

    if (qualityOptions.length === 0) {
      log.error('No available formats found for this video');
      process.exit(1);
    }

    log.info(t('download.downloading'));

    const downloadResults = await downloadVideo(videoInfo, {
      filename,
      downloadPath,
      qualities,
      downloadCover,
      downloadDescription,
      debug: debugMode,
      browser: settings.browser,
      formatSizes,
      mp3Bitrate: settings.mp3Bitrate,
    }, depPaths);

    const totalSizeMb = downloadResults.reduce((sum, result) => sum + result.sizeMb, 0);
    const totalFiles = downloadResults.length;

    log.success(t('download.downloadComplete'));
    log.info(t('download.totalFiles', { count: totalFiles }));
    log.info(t('download.totalSize', { size: Math.round(totalSizeMb * 100) / 100 }));

    for (const result of downloadResults) {
      log.info(t('download.fileInfo', { filename: result.filename, quality: result.quality, size: result.sizeMb }));
    }

    outro(t('menu.exit'));
  } catch (error: any) {
    s.stop();

    if (error.message === 'AUTH_REQUIRED') {
      log.error('');
      log.error(t('auth.required'));
      log.error(t('auth.youtubeBot'));
      log.info('');
      log.info(t('auth.solution'));
      log.info(t('auth.step1'));
      log.info(t('auth.step2'));
      log.info(t('auth.step3'));
      log.info(t('auth.step4'));
      log.info('');
    } else {
      log.error(t('common.error', { message: error.message }));
    }
    process.exit(1);
  }
}

program.parse();

main().catch((error) => {
  console.error('❌ Ошибка:', error);
  process.exit(1);
});