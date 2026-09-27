/**
 * 自动生成自定义定义的 ID。
 *
 * **为什么要这个模块**（用户实测反馈）：设置页里新增一个自定义地形/标记/路径类型/区域类型时，
 * 必须手打一个 ID，还要记住"只能用字母数字和 `-` `_`、`custom:` 前缀会自动补"这类规则；
 * 打错了只有一句笼统提示，改也不知道从哪改。可 ID 本来只是机器认的键 ——
 * **显示名才是人看的**，那就应该能自动生成。
 *
 * 生成规则（刻意保持"可读、可预测、不撞车"）：
 *   1. 显示名里的 ASCII 字母数字留下、其余字符压成 `-`，得到 slug
 *      （`My Forest!` → `my-forest`）；
 *   2. slug 非空且没被占用 → `custom:<slug>`；
 *   3. slug 为空（例如纯中文显示名「沼泽地」）或已被占用 → 退到 `custom:<词干><n>`
 *      （词干按类别给：`terrain` / `marker` / `path` / `region`），`n` 从 1 起找第一个没被占用的。
 *
 * 为什么纯中文不给拼音：本地没有可靠的拼音库，硬造一套映射只会让 ID 变得不可预测；
 * 而 ID 在界面上几乎不露面（用户看到的是显示名），所以"类别词干 + 短序号"比"猜出来的拼音"更诚实。
 *
 * ⚠️ 为什么不用 `custom:1` 这种纯序号：ID 规则是**小写字母开头**（`terrainIdProblem` 等四处
 * 纯函数都会这样校验），`custom:1` 会被自己的校验挡下 —— 这条是跑冒烟时当场发现的，
 * 不是设计时想到的（见 `docs/ENGINEERING-NOTES.md` 里"先跑一遍"的价值）。
 */

/** 单段 slug 的最大长度：ID 的用途是"稳定且短"，不是装下整句显示名 */
const MAX_SLUG_LENGTH = 24

/** 把显示名压成 slug（只保留 a-z0-9，其余压成单个 `-`） */
export function slugFromLabel(label: string): string {
  const lowered = label.trim().toLowerCase()
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-')
  const trimmed = replaced.replace(/^-+|-+$/g, '')
  return trimmed.length > MAX_SLUG_LENGTH ? trimmed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '') : trimmed
}

/**
 * 建议一个未被占用的自定义 ID。
 *
 * `existingIds` 传**同一类**定义现有的 ID（四类各自独立编号：地形的 `custom:terrain1`
 * 与标记的 `custom:marker1` 互不影响）。
 * `fallbackStem` 是"显示名里一个 ASCII 字母都没有"时用的类别词干（必须小写字母开头，见文件头）。
 */
export function suggestCustomId(
  label: string,
  existingIds: readonly string[],
  prefix = 'custom:',
  fallbackStem = 'item',
): string {
  const taken = new Set(existingIds)
  const slug = slugFromLabel(label)
  const base = slug.length > 0 ? `${prefix}${slug}` : `${prefix}${fallbackStem}`
  if (slug.length > 0 && !taken.has(base)) return base
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = `${base}${index}`
    if (!taken.has(candidate)) return candidate
  }
  // 理论上到不了这里（上限远小于 9999），但绝不返回一个已被占用的 ID
  return `${base}${Date.now()}`
}

/**
 * 判断 ID 输入框是不是"没填"。留空 = 让系统生成，所以空白字符串也算没填
 * （用户按了空格、或从别处粘贴了一段空白，都不该被当成"一个叫空格的 ID"）。
 */
export function isBlankCustomId(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0
}
