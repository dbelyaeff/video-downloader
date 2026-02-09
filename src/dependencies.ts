import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, createWriteStream, chmodSync, createReadStream } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { log, spinner } from '@clack/prompts';
import { t } from './i18n';

interface DependencyPaths {
  ytDlp: string;
  ffmpeg: string;
}

const DEPENDENCY_DIR = join(homedir(), '.video-downloader', 'bin');

function getPlatform(): 'darwin' | 'win32' | 'linux' {
  const plat = platform();
  if (plat === 'darwin') return 'darwin';
  if (plat === 'win32') return 'win32';
  return 'linux';
}

function getExecutableName(name: string): string {
  const plat = getPlatform();
  if (plat === 'win32') {
    return `${name}.exe`;
  }
  return name;
}

async function checkCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const checkCmd = getPlatform() === 'win32' ? 'where' : 'which';
    const child = spawn(checkCmd, [command], { stdio: 'ignore' });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
    
    child.on('error', () => {
      resolve(false);
    });
  });
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const plat = getPlatform();
      let command: string;
      let args: string[];
      
      if (plat === 'win32') {
        command = 'powershell';
        args = ['-Command', `Invoke-WebRequest -Uri '${url}' -OutFile '${destPath}' -UseBasicParsing`];
      } else {
        command = 'curl';
        args = ['-L', '--progress-bar', '-o', destPath, url];
      }
      
      const child = spawn(command, args);
      
      child.on('close', (code) => {
        if (code === 0) {
          if (plat !== 'win32') {
            try {
              chmodSync(destPath, 0o755);
            } catch {}
          }
          resolve(true);
        } else {
          resolve(false);
        }
      });
      
      child.on('error', () => {
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function extractArchive(archivePath: string, destDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const plat = getPlatform();
    let command: string;
    let args: string[];
    
    if (archivePath.endsWith('.zip')) {
      if (plat === 'win32') {
        command = 'powershell';
        args = ['-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`];
      } else {
        command = 'unzip';
        args = ['-o', archivePath, '-d', destDir];
      }
    } else if (archivePath.endsWith('.tar.xz') || archivePath.endsWith('.txz')) {
      if (plat === 'win32') {
        // Для Windows tar.xz используем 7z или другие инструменты
        resolve(false);
        return;
      } else {
        command = 'tar';
        args = ['-xf', archivePath, '-C', destDir];
      }
    } else {
      resolve(false);
      return;
    }
    
    const child = spawn(command, args, { stdio: 'ignore' });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
    
    child.on('error', () => {
      resolve(false);
    });
  });
}

async function installYtDlp(): Promise<string | null> {
  const s = spinner();
  s.start(t('dependencies.installingYtDlp'));

  const plat = getPlatform();
  const ytDlpName = getExecutableName('yt-dlp');
  const ytDlpPath = join(DEPENDENCY_DIR, ytDlpName);

  let url: string;
  if (plat === 'win32') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  } else if (plat === 'darwin') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  } else {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  }

  if (!existsSync(DEPENDENCY_DIR)) {
    mkdirSync(DEPENDENCY_DIR, { recursive: true });
  }

  const success = await downloadFile(url, ytDlpPath);

  if (success) {
    s.stop(t('dependencies.installed', { name: 'yt-dlp' }));
    return ytDlpPath;
  } else {
    s.stop(t('dependencies.installFailed', { name: 'yt-dlp' }));
    return null;
  }
}

async function installFfmpeg(): Promise<string | null> {
  const s = spinner();
  s.start(t('dependencies.installingFfmpeg'));

  const plat = getPlatform();
  const ffmpegName = getExecutableName('ffmpeg');
  const tempDir = join(DEPENDENCY_DIR, 'temp');

  if (!existsSync(DEPENDENCY_DIR)) {
    mkdirSync(DEPENDENCY_DIR, { recursive: true });
  }
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  let url: string;
  let archiveName: string;

  if (plat === 'darwin') {
    url = 'https://evermeet.cx/pub/ffmpeg/snapshots/ffmpeg-110645-g60dd5aba48.7z';
    archiveName = 'ffmpeg.7z';
  } else if (plat === 'linux') {
    url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz';
    archiveName = 'ffmpeg.tar.xz';
  } else if (plat === 'win32') {
    url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
    archiveName = 'ffmpeg.zip';
  } else {
    s.stop(t('common.error', { message: 'Unknown platform' }));
    return null;
  }

  const archivePath = join(tempDir, archiveName);

  // Скачиваем архив
  s.message(t('dependencies.downloading', { name: 'ffmpeg' }));
  const downloadSuccess = await downloadFile(url, archivePath);

  if (!downloadSuccess) {
    s.stop(t('dependencies.installFailed', { name: 'ffmpeg' }));
    return null;
  }

  // Распаковываем
  s.message(t('dependencies.extracting', { name: 'ffmpeg' }));
  const extractSuccess = await extractArchive(archivePath, tempDir);

  if (!extractSuccess) {
    s.stop(t('dependencies.installFailed', { name: 'ffmpeg' }));
    return null;
  }

  // Ищем ffmpeg в распакованной директории
  s.message(t('dependencies.searching', { name: 'ffmpeg' }));
  const ffmpegPath = await findFfmpegBinary(tempDir, plat);

  if (!ffmpegPath) {
    s.stop(t('common.notFound'));
    return null;
  }

  // Копируем ffmpeg в директорию bin
  const destPath = join(DEPENDENCY_DIR, ffmpegName);
  try {
    if (plat === 'win32') {
      const { copyFileSync } = require('fs');
      copyFileSync(ffmpegPath, destPath);

      const ffprobeSrc = ffmpegPath.replace('ffmpeg.exe', 'ffprobe.exe');
      if (existsSync(ffprobeSrc)) {
        copyFileSync(ffprobeSrc, join(DEPENDENCY_DIR, 'ffprobe.exe'));
      }
    } else {
      const { copyFileSync } = require('fs');
      copyFileSync(ffmpegPath, destPath);
      chmodSync(destPath, 0o755);
    }

    s.stop(t('dependencies.installed', { name: 'ffmpeg' }));
    return destPath;
  } catch (error) {
    s.stop(t('dependencies.installFailed', { name: 'ffmpeg' }));
    return null;
  }
}

async function findFfmpegBinary(dir: string, plat: string): Promise<string | null> {
  const { readdirSync, statSync } = require('fs');
  const ffmpegName = plat === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  
  try {
    const files = readdirSync(dir);
    
    for (const file of files) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Рекурсивно ищем в поддиректориях
        const result = await findFfmpegBinary(fullPath, plat);
        if (result) return result;
      } else if (file === ffmpegName) {
        return fullPath;
      }
    }
  } catch {
    return null;
  }
  
  return null;
}

export async function ensureDependencies(): Promise<DependencyPaths | null> {
  const plat = getPlatform();
  
  let ytDlpPath: string | null = null;
  let ffmpegPath: string | null = null;
  
  // Проверяем yt-dlp
  if (await checkCommand('yt-dlp')) {
    ytDlpPath = 'yt-dlp';
  } else if (await checkCommand('yt-dlp.exe')) {
    ytDlpPath = 'yt-dlp.exe';
  } else {
    const localYtDlp = join(DEPENDENCY_DIR, getExecutableName('yt-dlp'));
    if (existsSync(localYtDlp)) {
      ytDlpPath = localYtDlp;
    } else {
      ytDlpPath = await installYtDlp();
    }
  }
  
  // Проверяем ffmpeg
  if (await checkCommand('ffmpeg')) {
    ffmpegPath = 'ffmpeg';
  } else if (await checkCommand('ffmpeg.exe')) {
    ffmpegPath = 'ffmpeg.exe';
  } else {
    const localFfmpeg = join(DEPENDENCY_DIR, getExecutableName('ffmpeg'));
    if (existsSync(localFfmpeg)) {
      ffmpegPath = localFfmpeg;
    } else {
      // Автоматически устанавливаем ffmpeg
      ffmpegPath = await installFfmpeg();
    }
  }
  
  if (!ytDlpPath) {
    log.error(t('dependencies.ytDlpNotFound'));
    return null;
  }

  if (!ffmpegPath) {
    log.warn(t('dependencies.ffmpegNotFound'));
  }

  return {
    ytDlp: ytDlpPath,
    ffmpeg: ffmpegPath || 'ffmpeg',
  };
}

export function getYtDlpCommand(paths: DependencyPaths): string {
  return paths.ytDlp;
}

export function getFfmpegCommand(paths: DependencyPaths): string {
  return paths.ffmpeg;
}