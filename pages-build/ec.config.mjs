// Expressive Code options live here rather than in astro.config.mjs because
// the `<Code>` component (used on the component pages) re-creates its renderer
// from a JSON-serialised copy of the config, and a plugin function cannot be
// serialised. Starlight and the `<Code>` component both read this file.
import { languageLabels } from './src/lib/ec-language-labels.mjs';

export default {
  plugins: [languageLabels()],
};
