import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { load, dump } from 'yaml';

// Available languages
export const AVAILABLE_LANGUAGES = ['en', 'ru'] as const;
export type Language = typeof AVAILABLE_LANGUAGES[number];

interface TranslationData {
  [key: string]: string | TranslationData;
}

// Cache for translations
const translationsCache: Map<Language, TranslationData> = new Map();

// Default language
export const DEFAULT_LANGUAGE: Language = 'en';

/**
 * Get system language
 */
export function getSystemLanguage(): Language {
  const envLang = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || '';
  
  // Check if Russian
  if (envLang.toLowerCase().includes('ru')) {
    return 'ru';
  }
  
  // Default to English
  return 'en';
}

/**
 * Load translations for a language
 */
function loadTranslations(lang: Language): TranslationData {
  if (translationsCache.has(lang)) {
    return translationsCache.get(lang)!;
  }
  
  const filePath = join(__dirname, '..', 'i18n', `${lang}.json`);
  
  if (!existsSync(filePath)) {
    console.warn(`Translation file not found: ${filePath}`);
    return {};
  }
  
  try {
    const content = readFileSync(filePath, 'utf8');
    const translations = JSON.parse(content);
    translationsCache.set(lang, translations);
    return translations;
  } catch (error) {
    console.warn(`Failed to load translations for ${lang}:`, error);
    return {};
  }
}

/**
 * Get nested value from translations object
 */
function getNestedValue(obj: TranslationData, path: string): string | undefined {
  const keys = path.split('.');
  let current: any = obj;
  
  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[key];
  }
  
  return typeof current === 'string' ? current : undefined;
}

/**
 * Interpolate values into a string
 */
function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Translation function
 */
export function t(key: string, values?: Record<string, string | number>, lang?: Language): string {
  const currentLang = lang || getCurrentLanguage();
  const translations = loadTranslations(currentLang);
  
  let text = getNestedValue(translations, key);
  
  // Fallback to English if translation not found
  if (!text && currentLang !== 'en') {
    const enTranslations = loadTranslations('en');
    text = getNestedValue(enTranslations, key);
  }
  
  // Return key if translation not found
  if (!text) {
    return key;
  }
  
  return interpolate(text, values);
}

// Current language storage
let currentLanguage: Language = DEFAULT_LANGUAGE;

/**
 * Get current language
 */
export function getCurrentLanguage(): Language {
  return currentLanguage;
}

/**
 * Set current language
 */
export function setCurrentLanguage(lang: Language): void {
  if (AVAILABLE_LANGUAGES.includes(lang)) {
    currentLanguage = lang;
  }
}

/**
 * Check if language is available
 */
export function isValidLanguage(lang: string): lang is Language {
  return AVAILABLE_LANGUAGES.includes(lang as Language);
}