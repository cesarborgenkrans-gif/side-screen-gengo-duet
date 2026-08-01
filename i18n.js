/* Generated locale packages live in locales/gengo-duet-locales.js.
   This adapter owns only runtime language metadata and TTS language routing. */
(() => {
  'use strict';

  const packages = window.GENGO_DUET_LOCALES || {};
  const metadata = [
    { code: 'en', native: 'English', llm: 'English explanations with Japanese examples, kana, and natural translations', voxcpm: 'English' },
    { code: 'ja', native: '日本語', llm: 'simple Japanese with Japanese examples and kana; add short beginner glosses only when essential', voxcpm: 'Japanese' },
    { code: 'sv', native: 'Svenska', llm: 'Swedish explanations with Japanese examples, kana, and natural translations', voxcpm: 'Swedish' },
    { code: 'zh-Hans', native: '简体中文', llm: 'Simplified Chinese explanations with Japanese examples, kana, and natural translations', voxcpm: 'Chinese' },
    { code: 'zh-Hant', native: '繁體中文', llm: 'Traditional Chinese explanations with Japanese examples, kana, and natural translations', voxcpm: 'Chinese' },
    { code: 'ko', native: '한국어', llm: 'Korean explanations with Japanese examples, kana, and natural translations', voxcpm: 'Korean' },
    { code: 'id', native: 'Bahasa Indonesia', llm: 'Indonesian explanations with Japanese examples, kana, and natural translations', voxcpm: 'Indonesian' },
    { code: 'vi', native: 'Tiếng Việt', llm: 'Vietnamese explanations with Japanese examples, kana, and natural translations', voxcpm: 'Vietnamese' },
    { code: 'th', native: 'ไทย', llm: 'Thai explanations with Japanese examples, kana, and natural translations', voxcpm: 'Thai' },
    { code: 'hi', native: 'हिन्दी', llm: 'Hindi explanations with Japanese examples, kana, and natural translations', voxcpm: 'Hindi' },
    { code: 'es', native: 'Español', llm: 'Spanish explanations with Japanese examples, kana, and natural translations', voxcpm: 'Spanish' },
    { code: 'pt-BR', native: 'Português (Brasil)', llm: 'Brazilian Portuguese explanations with Japanese examples, kana, and natural translations', voxcpm: 'Portuguese' },
    { code: 'fr', native: 'Français', llm: 'French explanations with Japanese examples, kana, and natural translations', voxcpm: 'French' },
    { code: 'de', native: 'Deutsch', llm: 'German explanations with Japanese examples, kana, and natural translations', voxcpm: 'German' },
    { code: 'pl', native: 'Polski', llm: 'Polish explanations with Japanese examples, kana, and natural translations', voxcpm: 'Polish' },
    { code: 'ru', native: 'Русский', llm: 'Russian explanations with Japanese examples, kana, and natural translations', voxcpm: 'Russian' },
    { code: 'it', native: 'Italiano', llm: 'Italian explanations with Japanese examples, kana, and natural translations', voxcpm: 'Italian' },
    { code: 'ms', native: 'Bahasa Melayu', llm: 'Malay explanations with Japanese examples, kana, and natural translations', voxcpm: 'Malay' }
  ];

  window.I18N_LANGS = metadata;
  window.I18N = Object.fromEntries(metadata.map(({ code }) => [code, packages[code]?.strings || {}]));
  window.I18N_REQUIRED_KEYS = Object.keys(packages.en?.strings || {});
  window.I18N_SOURCE_HASH = packages.en?.sourceHash || '';
})();
