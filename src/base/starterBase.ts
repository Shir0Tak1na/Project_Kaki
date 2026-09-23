/**
 * 生成一份可以直接打开的 `.base` 起始文件（**纯函数，可测**）。
 *
 * 为什么要有它：Base 视图的价值只有在 `.base` 文件里写对了视图条目才体现出来，
 * 而手写 YAML 很容易错（缩进、引号、视图类型 id）。让插件替用户写一份，
 * 用户只要打开文件、把视图类型切到「地图」即可。
 *
 * 为什么不用过滤器：Base 的过滤表达式语法细节较多（属性名写法、null 字面量），
 * 写错了整个 Base 会报错。这里改为把过滤条件**以注释形式给出**，
 * 用户需要时自己取消注释 —— 宁可少做一步，也不要生成一个打不开的文件。
 */

import {
  BASES_VIEW_TYPE,
  DEFAULT_COORD_PROPERTY,
  DEFAULT_REGION_PROPERTY,
  DEFAULT_TYPE_PROPERTY,
  OPTION_KEYS,
} from './viewContract.ts'

/** YAML 双引号标量：转义反斜杠与双引号（剩下的（如 `:`、`#`）在双引号里都是安全的） */
export function quoteYaml(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

export function buildStarterBaseFile(mapPath: string): string {
  const lines = [
    '# 由 Project Kaki 生成。',
    '# 打开这个文件后，把视图类型切换为「地图」，并在视图选项里确认地图文档。',
    '#',
    '# 只想列出带坐标的笔记？把下面两行前的 # 去掉：',
    '# filters:',
    "#   and:",
    "#     - 'coordinates != null'",
    '',
    'views:',
    `  - type: ${BASES_VIEW_TYPE}`,
    '    name: 地图',
    '    order:',
    '      - file.name',
    `      - ${DEFAULT_TYPE_PROPERTY}`,
    `      - ${DEFAULT_REGION_PROPERTY}`,
    `      - ${DEFAULT_COORD_PROPERTY}`,
    `    ${OPTION_KEYS.mapFile}: ${quoteYaml(mapPath)}`,
    `    ${OPTION_KEYS.coordProperty}: ${DEFAULT_COORD_PROPERTY}`,
    `    ${OPTION_KEYS.typeProperty}: ${DEFAULT_TYPE_PROPERTY}`,
    `    ${OPTION_KEYS.regionProperty}: ${DEFAULT_REGION_PROPERTY}`,
    `    ${OPTION_KEYS.sortBy}: name`,
    '',
  ]
  return lines.join('\n')
}
