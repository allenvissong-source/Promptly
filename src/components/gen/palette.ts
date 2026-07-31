// 富文本工具条用色板。取自用户提供的飞书风格色板 PNG，逐格采样得到的
// 精确 hex（6 行 × 13 列：第 0 行为鲜艳主色，第 1~5 行为由浅到深的明度
// 梯度；第 0 列为灰阶）。文字色与背景色共用同一张表。
export const PALETTE_ROWS: string[][] = [
  ['#FFFFFF', '#5084FD', '#64D5FF', '#ABF1E8', '#03D7BA', '#36C825', '#B4D701', '#FFF25A', '#FF8903', '#FFD7AB', '#F88782', '#F14DA8', '#803DF3'],
  ['#F8F9FA', '#DDE5FA', '#E6F7FB', '#F1FCFA', '#D6F6F2', '#DAF5D7', '#EEF6C6', '#FAF1D0', '#FED5A3', '#FEF1DF', '#FCD5D3', '#FDDDEE', '#ECE2FC'],
  ['#DEE0E3', '#BBCFFD', '#AAE7FA', '#CCF7EF', '#66E8D5', '#8FE086', '#C4DD42', '#FAD457', '#FFBB6D', '#FFE8CE', '#F99C97', '#F57CBF', '#AE83F5'],
  ['#90969D', '#3572FD', '#59BFE5', '#ACE6DE', '#07B59D', '#30A224', '#90AD05', '#FFC70D', '#DE7A05', '#F4D2AB', '#E57C75', '#F02093', '#6628D1'],
  ['#393E43', '#275DD9', '#59AAC5', '#ACCBC6', '#066556', '#1B6211', '#687B02', '#DC9C05', '#905209', '#DAC5AB', '#AB6F6B', '#9F1662', '#3A1083'],
  ['#22262A', '#163E99', '#5797AC', '#ABC3BE', '#054D41', '#154D0D', '#4B5901', '#7B5302', '#6D3B01', '#CEBDA9', '#976967', '#7C124D', '#2A0863'],
];

// 扁平列表，便于「当前色是否在色板内」的匹配与渲染回退。
export const PALETTE_FLAT: string[] = PALETTE_ROWS.flat();

// 归一化为大写 #RRGGBB，供选中态比对（忽略大小写 / 三位缩写）。
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  // rgb(r, g, b) -> #RRGGBB
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const to = (n: string) => Number(n).toString(16).padStart(2, '0');
    return ('#' + to(m[1]) + to(m[2]) + to(m[3])).toUpperCase();
  }
  if (s[0] !== '#') s = '#' + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null;
}
