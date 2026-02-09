import { intro, outro, select, text, multiselect, log, spinner, isCancel } from '@clack/prompts';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { parse, stringify } from 'yaml';
import { homedir } from 'os';
import { ensureDependencies, getYtDlpCommand, getFfmpegCommand, DependencyPaths } from './dependencies';
import { t, getSystemLanguage, setCurrentLanguage, AVAILABLE_LANGUAGES, Language, isValidLanguage, DEFAULT_LANGUAGE } from './i18n';

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
        const errorMsg = debug || process.env.DEBUG === 'true' 
          ? `Failed to get video information: ${errorOutput}` 
          : 'Failed to get video information';
        reject(new Error(errorMsg));
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
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
            'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3, 'TiB': 1024**4,
            'KB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4
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
          'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3, 'TiB': 1024**4,
          'KB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4
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
    s.start('🖼️ Загрузка обложки...');

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

    s.stop('✅ Обложка загружена');
  }

  // Скачиваем описание если нужно
  if (options.downloadDescription) {
    const s = spinner();
    s.start('📝 Загрузка описания...');

    const descArgs: string[] = ['--write-description', '--skip-download'];
    if (options.browser) {
      descArgs.push('--cookies-from-browser', options.browser);
    }
    descArgs.push('--output', join(options.downloadPath, baseFilename));
    descArgs.push(videoInfo.webpage_url);
    
    await new Promise<void>((resolve) => {
      const child = spawn('yt-dlp', descArgs);
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
    
    s.stop('✅ Описание загружено');
  }
  
  // Метаданные и обложка для MP3 добавляются автоматически yt-dlp через --embed-thumbnail --add-metadata
  
  return results;
}

async function main() {
  // Загружаем настройки сначала
  const settings = loadSettings();

  // Спрашиваем язык при первом запуске
  await askForLanguageOnFirstRun(settings);

  // Устанавливаем язык из настроек
  setCurrentLanguage(settings.language);

  intro(t('app.title'));

  // Проверяем и устанавливаем зависимости
  const depPaths = await ensureDependencies();
  if (!depPaths) {
    outro(t('dependencies.initFailed'));
    process.exit(1);
  }

  log.success(t('dependencies.checking'));
  
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

async function configureSettings(settings: Settings): Promise<void> {
  const newSettings = await select<string>({
    message: t('settings.title'),
    options: [
      { label: t('settings.defaultDownloadPath'), value: 'defaultDownloadPath' },
      { label: t('settings.defaultFilename'), value: 'defaultFilename' },
      { label: t('settings.preferredQuality'), value: 'preferredQuality' },
      { label: t('settings.downloadCover'), value: 'downloadCover' },
      { label: t('settings.downloadDescription'), value: 'downloadDescription' },
      { label: t('settings.debug'), value: 'debug' },
      { label: t('settings.browser'), value: 'browser' },
      { label: t('settings.mp3Bitrate'), value: 'mp3Bitrate' },
      { label: t('settings.language'), value: 'language' },
      { label: t('settings.save'), value: 'save' },
    ],
  });

  if (isCancel(newSettings)) {
    return;
  }

  switch (newSettings) {
    case 'defaultDownloadPath':
      settings.defaultDownloadPath = await text({
        message: t('download.enterPath'),
        placeholder: settings.defaultDownloadPath || '',
      });
      break;
    case 'defaultFilename':
      settings.defaultFilename = await text({
        message: t('settings.defaultFilename'),
        placeholder: settings.defaultFilename || '',
      });
      break;
    case 'preferredQuality':
      const qualityResult = await select<string>({
        message: t('settings.preferredQuality'),
        options: [
          { label: t('qualities.highest'), value: 'highest' },
          { label: '4K', value: '4K' },
          { label: '1080p', value: '1080p' },
          { label: '720p', value: '720p' },
          { label: '480p', value: '480p' },
          { label: t('qualities.mp3'), value: 'mp3' },
        ],
      });
      if (!isCancel(qualityResult) && typeof qualityResult === 'string') {
        settings.preferredQuality = qualityResult;
      }
      break;
    case 'downloadCover':
      const coverChoice = await select<boolean>({
        message: t('settings.downloadCover') + '?',
        options: [
          { label: t('common.yes'), value: true },
          { label: t('common.no'), value: false },
        ],
        initialValue: settings.downloadCover,
      });
      if (!isCancel(coverChoice) && typeof coverChoice === 'boolean') {
        settings.downloadCover = coverChoice;
      }
      break;
    case 'downloadDescription':
      const descChoice = await select<boolean>({
        message: t('settings.downloadDescription') + '?',
        options: [
          { label: t('common.yes'), value: true },
          { label: t('common.no'), value: false },
        ],
        initialValue: settings.downloadDescription,
      });
      if (!isCancel(descChoice) && typeof descChoice === 'boolean') {
        settings.downloadDescription = descChoice;
      }
      break;
    case 'debug':
      const debugChoice = await select<boolean>({
        message: t('settings.debug') + '?',
        options: [
          { label: t('common.yes'), value: true },
          { label: t('common.no'), value: false },
        ],
        initialValue: settings.debug,
      });
      if (!isCancel(debugChoice) && typeof debugChoice === 'boolean') {
        settings.debug = debugChoice;
      }
      break;
    case 'browser':
      const browserResult = await select<string>({
        message: t('settings.browser'),
        options: [
          { label: t('browsers.none'), value: '' },
          { label: 'Chrome', value: 'chrome' },
          { label: 'Firefox', value: 'firefox' },
          { label: 'Safari', value: 'safari' },
          { label: 'Edge', value: 'edge' },
          { label: 'Brave', value: 'brave' },
          { label: 'Opera', value: 'opera' },
        ],
      });
      if (!isCancel(browserResult) && typeof browserResult === 'string') {
        settings.browser = browserResult;
      }
      break;
    case 'mp3Bitrate':
      const bitrateResult = await select<number>({
        message: t('settings.mp3Bitrate'),
        options: [
          { label: t('bitrates.64'), value: 64 },
          { label: t('bitrates.96'), value: 96 },
          { label: t('bitrates.128'), value: 128 },
          { label: t('bitrates.192'), value: 192 },
          { label: t('bitrates.256'), value: 256 },
          { label: t('bitrates.320'), value: 320 },
        ],
        initialValue: settings.mp3Bitrate,
      });
      if (!isCancel(bitrateResult) && typeof bitrateResult === 'number') {
        settings.mp3Bitrate = bitrateResult;
      }
      break;
    case 'language':
      const languageResult = await select<Language>({
        message: t('language.select'),
        options: [
          { label: t('language.en'), value: 'en' },
          { label: t('language.ru'), value: 'ru' },
        ],
        initialValue: settings.language,
      });
      if (!isCancel(languageResult) && isValidLanguage(languageResult)) {
        settings.language = languageResult;
        setCurrentLanguage(languageResult);
      }
      break;
    case 'save':
      saveSettings(settings);
      log.success(t('common.success'));
      return;
  }

  await configureSettings(settings);
}
  
  switch (newSettings) {
    case 'defaultDownloadPath':
      settings.defaultDownloadPath = await text({
        message: 'Введите путь к папке (оставьте пустым для текущей директории):',
        placeholder: settings.defaultDownloadPath || '',
      });
      break;
    case 'defaultFilename':
      settings.defaultFilename = await text({
        message: 'Имя файла по умолчанию:',
        placeholder: settings.defaultFilename || '',
      });
      break;
    case 'preferredQuality':
      const qualityResult = await select<string>({
        message: 'Выберите предпочитаемое качество:',
        options: [
          { label: 'Наивысшее', value: 'highest' },
          { label: '4K', value: '4K' },
          { label: '1080p', value: '1080p' },
          { label: '720p', value: '720p' },
          { label: '480p', value: '480p' },
          { label: 'Аудио (mp3)', value: 'mp3' },
        ],
      });
      if (!isCancel(qualityResult) && typeof qualityResult === 'string') {
        settings.preferredQuality = qualityResult;
      }
      break;
    case 'downloadCover':
      const coverChoice = await select<boolean>({
        message: 'Загружать обложку?',
        options: [
          { label: 'Да', value: true },
          { label: 'Нет', value: false },
        ],
        initialValue: settings.downloadCover,
      });
      if (!isCancel(coverChoice) && typeof coverChoice === 'boolean') {
        settings.downloadCover = coverChoice;
      }
      break;
    case 'downloadDescription':
      const descChoice = await select<boolean>({
        message: 'Загружать описание?',
        options: [
          { label: 'Да', value: true },
          { label: 'Нет', value: false },
        ],
        initialValue: settings.downloadDescription,
      });
      if (!isCancel(descChoice) && typeof descChoice === 'boolean') {
        settings.downloadDescription = descChoice;
      }
      break;
    case 'debug':
      const debugChoice = await select<boolean>({
        message: 'Включить режим отладки?',
        options: [
          { label: 'Да', value: true },
          { label: 'Нет', value: false },
        ],
        initialValue: settings.debug,
      });
      if (!isCancel(debugChoice) && typeof debugChoice === 'boolean') {
        settings.debug = debugChoice;
      }
      break;
    case 'browser':
      const browserResult = await select<string>({
        message: 'Выберите браузер для получения cookies:',
        options: [
          { label: 'Не использовать', value: '' },
          { label: 'Chrome', value: 'chrome' },
          { label: 'Firefox', value: 'firefox' },
          { label: 'Safari', value: 'safari' },
          { label: 'Edge', value: 'edge' },
          { label: 'Brave', value: 'brave' },
          { label: 'Opera', value: 'opera' },
        ],
      });
      if (!isCancel(browserResult) && typeof browserResult === 'string') {
        settings.browser = browserResult;
      }
      break;
    case 'mp3Bitrate':
      const bitrateResult = await select<number>({
        message: 'Выберите битрейт MP3:',
        options: [
          { label: '64 Kbps (экономия места)', value: 64 },
          { label: '96 Kbps', value: 96 },
          { label: '128 Kbps (стандарт)', value: 128 },
          { label: '192 Kbps', value: 192 },
          { label: '256 Kbps', value: 256 },
          { label: '320 Kbps (максимальное качество)', value: 320 },
        ],
        initialValue: settings.mp3Bitrate,
      });
      if (!isCancel(bitrateResult) && typeof bitrateResult === 'number') {
        settings.mp3Bitrate = bitrateResult;
      }
      break;
    case 'save':
      saveSettings(settings);
      log.success('✅ Настройки сохранены');
      return;
  }
  
  await configureSettings(settings);
}

async function downloadVideoFlow(settings: Settings, depPaths: DependencyPaths): Promise<void> {
  const url = await text({
    message: t('download.enterUrl'),
    placeholder: 'https://www.youtube.com/watch?v=...',
  });

  if (isCancel(url) || !url) {
    log.error(t('common.error', { message: 'URL' }));
    return;
  }

  const s = spinner();
  s.start(t('download.gettingVideoInfo'));

  try {
    const videoInfo = await getVideoInfo(url, settings.debug, settings.browser, depPaths);
    s.stop(t('common.success'));

    if (!videoInfo) {
      log.error(t('common.error', { message: 'Video info' }));
      return;
    }

    const filename = await text({
      message: t('download.enterFilename'),
      placeholder: videoInfo.title || 'video',
      initialValue: videoInfo.title || 'video',
    });

    if (isCancel(filename)) {
      log.info(t('common.cancelled'));
      return;
    }

    const downloadPath = await text({
      message: t('download.enterPath'),
      placeholder: settings.defaultDownloadPath || process.cwd(),
      initialValue: settings.defaultDownloadPath || process.cwd(),
    });

    if (isCancel(downloadPath)) {
      log.info(t('common.cancelled'));
      return;
    }

    // Получаем размеры для каждого качества
    log.info(t('download.gettingFormatSizes'));
    const formatSizes = await getFormatSizes(url, settings.browser, settings.debug, depPaths);

    const qualityOptions = [
      { label: `4K${formatSizes.has('4K') ? ` (${formatSizes.get('4K')})` : ''}`, value: '4K' },
      { label: `1080p${formatSizes.has('1080p') ? ` (${formatSizes.get('1080p')})` : ''}`, value: '1080p' },
      { label: `720p${formatSizes.has('720p') ? ` (${formatSizes.get('720p')})` : ''}`, value: '720p' },
      { label: `480p${formatSizes.has('480p') ? ` (${formatSizes.get('480p')})` : ''}`, value: '480p' },
      { label: `${t('qualities.mp3')}${formatSizes.has('mp3') ? ` (${formatSizes.get('mp3')})` : ''}`, value: 'mp3' },
    ];

    const qualities = await multiselect<string>({
      message: t('download.selectQuality'),
      options: qualityOptions,
      required: true,
    });

    if (isCancel(qualities) || !qualities || qualities.length === 0) {
      log.error(t('common.required'));
      return;
    }

    const confirmDownload = await select<boolean>({
      message: t('download.confirmDownload'),
      options: [
        { label: t('common.yes'), value: true },
        { label: t('common.no'), value: false },
      ],
    });

    if (isCancel(confirmDownload) || !confirmDownload) {
      log.info(t('common.cancelled'));
      return;
    }

    log.info(t('download.downloading'));
    
    const downloadResults = await downloadVideo(videoInfo, {
      filename: filename,
      downloadPath: expandPath(downloadPath || process.cwd()),
      qualities,
      downloadCover: settings.downloadCover,
      downloadDescription: settings.downloadDescription,
      debug: settings.debug,
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

  } catch (error) {
    s.stop();
    log.error(t('common.error', { message: error.message }));
  }
}

main().catch((error) => {
  console.error('❌ Ошибка:', error);
  process.exit(1);
});