/**
 * 极简 monkey-patch 工具。
 *
 * 为什么自己写而不是装 monkey-around：Phase 0 只需要包装一两个方法，
 * 少一个依赖就少一处供应链与版本风险。行为与 Advanced Canvas 使用的
 * around() 一致：包装 → 返回可逆的卸载函数。
 *
 * 约束：
 * - 包装后的函数以 target 为 this 调用原实现（Canvas 内部方法都是实例调用，成立）。
 * - 卸载时只有当前值仍是我们装上去的那个函数才还原，避免把别人的补丁一起抹掉。
 */

export type Uninstaller = () => void

type AnyFn = (...args: unknown[]) => unknown

export function around<T extends object, K extends keyof T & string>(
  target: T,
  name: K,
  factory: (next: AnyFn) => AnyFn,
): Uninstaller {
  const container = target as unknown as Record<string, unknown>
  const original = container[name]
  if (typeof original !== 'function') {
    throw new Error(`around(): ${String(name)} 不是函数，无法补丁`)
  }

  const bound = (original as AnyFn).bind(target)
  const wrapped = factory(bound)
  container[name] = wrapped

  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (container[name] === wrapped) container[name] = original
  }
}

/** 批量安装：任一失败即回滚已装的部分，并抛出原因 */
export function installAll(installers: Array<() => Uninstaller>): Uninstaller {
  const done: Uninstaller[] = []
  try {
    for (const install of installers) done.push(install())
  } catch (err) {
    for (const undo of done.reverse()) undo()
    throw err
  }
  return () => {
    for (const undo of done.reverse()) undo()
    done.length = 0
  }
}
