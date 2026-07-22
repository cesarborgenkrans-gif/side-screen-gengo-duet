import fs from 'node:fs';
import vm from 'node:vm';

const bundlePath = new URL('../locales/gengo-duet-locales.js', import.meta.url);
const i18nPath = new URL('../i18n.js', import.meta.url);
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), context, { filename: 'gengo-duet-locales.js' });
vm.runInContext(fs.readFileSync(i18nPath, 'utf8'), context, { filename: 'i18n.js' });

const { I18N, I18N_LANGS } = context.window;
const required = Object.keys(I18N?.en || {});
const failures = [];

for (const lang of I18N_LANGS || []) {
  const missing = required.filter(key => !Object.hasOwn(I18N[lang.code] || {}, key));
  if (missing.length) failures.push(`${lang.code}: ${missing.join(', ')}`);
}

if (failures.length) {
  console.error(`i18n check failed:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`i18n OK — ${(I18N_LANGS || []).length} languages × ${required.length} keys.`);
}
