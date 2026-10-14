export interface SearchOption {
  value: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
}

const dictionary = new Intl.Collator('zh-CN-u-co-pinyin', {
  sensitivity: 'base',
  numeric: true,
});
const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function dictionaryOptions(options: readonly SearchOption[]): SearchOption[] {
  return [...options].sort(
    (a, b) =>
      dictionary.compare(a.label, b.label) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}

function fragmentMatches(text: string, fragment: string): boolean {
  if (text.includes(fragment)) return true;
  // File extensions should not turn `cdx` into a match for every `Code.exe`.
  const name = text.replace(/\.(?:exe|app)$/, '');
  const letters = Array.from(fragment);
  let index = 0;
  for (const character of name) {
    if (character === letters[index]) index++;
    if (index === letters.length) return true;
  }
  return false;
}

export function filterOptions(options: readonly SearchOption[], query: string): SearchOption[] {
  const fragments = normalize(query).trim().split(/\s+/).filter(Boolean);
  return options.filter((option) => {
    const fields = [option.label, option.description ?? '', ...(option.keywords ?? [])].map(
      normalize,
    );
    return fragments.every(
      (fragment) =>
        normalize(option.value).includes(fragment) ||
        fields.some((text) => fragmentMatches(text, fragment)),
    );
  });
}
