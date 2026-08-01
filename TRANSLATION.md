# Gengo Duet Translation Notes

The app uses static offline locale packages generated from `D:/ai-translation/projects/side-screen-gengo-duet/`. There is no translation API. `locales/gengo-duet-locales.js` contains the translated copy; `i18n.js` contains only runtime language and voice metadata.

One selector controls three surfaces:

1. UI labels through `data-i18n` and `data-i18n-ph`.
2. The LLM explanation language through `langMeta().llm`.
3. Compatible local TTS language through `langMeta().voxcpm`.

The standard release contains 17 translated locales plus canonical English: 18 selectable languages in total.

Brand, mascot, and model names stay untranslated: SparkleSnap, Tsuki, Selene, LM Studio, Ollama, OpenRouter, VoiceGen-Oui-ROCm-VoxCPM2, VRAM.

When adding copy, update the English source in the Translation Center, translate only new or changed units, run `honyaku check side-screen-gengo-duet`, then export. Missing runtime keys fall back to English, then to the raw key.
