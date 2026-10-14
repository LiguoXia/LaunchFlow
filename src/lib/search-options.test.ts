import { describe, expect, it } from 'vitest';
import { dictionaryOptions, filterOptions } from './search-options';

describe('searchable selection', () => {
  it('sorts Chinese by pinyin and Latin names naturally, retaining duplicate identities', () => {
    const input = [
      { value: 'w', label: '微信' },
      { value: 'b', label: '百度' },
      { value: 'a', label: '阿里' },
      { value: '10', label: 'Code 10' },
      { value: '2', label: 'Code 2' },
      { value: 'z-id', label: 'Codex' },
      { value: 'a-id', label: 'Codex' },
    ];
    const sorted = dictionaryOptions(input);
    expect(
      sorted
        .filter((option) => ['w', 'b', 'a'].includes(option.value))
        .map((option) => option.label),
    ).toEqual(['阿里', '百度', '微信']);
    expect(
      sorted.filter((option) => option.label.startsWith('Code ')).map((option) => option.label),
    ).toEqual(['Code 2', 'Code 10']);
    expect(
      sorted.filter((option) => option.label === 'Codex').map((option) => option.value),
    ).toEqual(['a-id', 'z-id']);
    expect(input[0].value).toBe('w');
  });
  it('matches Chinese fragments, non-adjacent letters, case, width and executable aliases', () => {
    const sorted = dictionaryOptions([
      { value: 'chat', label: 'Codex', keywords: ['ChatGPT.exe'] },
      { value: 'wechat', label: '微信', keywords: ['Weixin.exe'] },
      {
        value: 'editor',
        label: 'Visual Studio Code',
        description: '项目编辑器',
        keywords: ['Code.exe'],
      },
    ]);
    for (const query of ['cdx', 'ＣＯＤＥＸ', 'chatgpt'])
      expect(filterOptions(sorted, query)[0].value).toBe('chat');
    for (const query of ['微', 'wix', 'WEIXIN'])
      expect(filterOptions(sorted, query)[0].value).toBe('wechat');
    expect(filterOptions(sorted, 'vsc 项目').map((option) => option.value)).toEqual(['editor']);
    expect(filterOptions(sorted, '   ')).toEqual(sorted);
    expect(filterOptions(sorted, '不存在的应用')).toEqual([]);
    expect(filterOptions(sorted, 'cdx').map((option) => option.value)).toEqual(['chat']);
  });
});
