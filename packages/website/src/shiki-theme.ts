// One definition, imported by astro.config.mjs for markdown and by any page that
// calls codeToHtml directly. Duplicating it drifts: the two copies stop matching
// and half the code blocks quietly render in a different palette.
export const vcutTheme = {
  name: 'vcut',
  type: 'dark' as const,
  settings: [
    {
      scope: ['comment', 'comment.line', 'punctuation.definition.comment'],
      settings: { foreground: '#78716C', fontStyle: 'italic' },
    },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#FCD34D' } },
    { scope: ['constant', 'constant.numeric'], settings: { foreground: '#FBBF24' } },
    {
      scope: ['keyword', 'keyword.operator', 'keyword.control'],
      settings: { foreground: '#FDE68A' },
    },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#FFFFFF' } },
    { scope: ['variable', 'variable.other'], settings: { foreground: '#E7E5E4' } },
    { scope: ['punctuation'], settings: { foreground: '#A8A29E' } },
    { scope: ['source', 'text'], settings: { foreground: '#D6D3D1' } },
  ],
  colors: {
    'editor.background': '#1C1917',
    'editor.foreground': '#D6D3D1',
  },
}
