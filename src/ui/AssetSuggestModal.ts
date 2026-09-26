/**
 * 「从库里选一个文件」的弹窗（图片 / 定义文件）。
 *
 * 为什么是"库内文件"而不是系统文件对话框：
 * Obsidian **没有暴露系统级文件选择 API**（只有 Electron 内部才有，插件拿不到）。
 * 这在数据上也更对 —— 地图文件里存的是**库内相对路径**，把库同步到别的机器、或分享给别人，
 * 图片仍然找得到；用系统对话框选一个库外的文件，那条路径在别人机器上必然失效。
 *
 * 为什么把它做成**可注入的工厂**（`ImagePickerFactory`）：
 * 1. `FuzzySuggestModal` 的模糊搜索 UI 无法在冒烟环境里可信地复现（假 obsidian 里没有这个基类）；
 * 2. 真正要断言的是"选中之后路径有没有写进设置、非法选择有没有被拒、库里没图时有没有可读提示"，
 *    这些都不需要弹窗真的显示出来。注入替身之后，冒烟能精确控制"用户选了哪一项"。
 * 3. 与既有的 `setPlaceModalFactory` / `setPromptModalFactory` / `setReportModalFactory` 同一模式。
 *
 * 这个类本身很薄：筛选与排序、短标签都在纯函数模块 `assetFiles.ts` 里（有单测），
 * 它只负责"把清单交给 FuzzySuggestModal 的搜索框"。
 */

import { FuzzySuggestModal, type App } from 'obsidian'
import { describeAssetChoice, listBundlePaths, listImagePaths } from '../base/assetFiles.ts'

/**
 * 候选属于哪一类。**必须由调用方显式给出**，不能在弹窗里靠扩展名猜 ——
 * 「该列什么」是调用方的知识（它才知道自己在选图片还是选定义文件）。
 */
export type AssetPickerKind = 'image' | 'bundle'

export interface AssetPickerOptions {
  /** 候选路径（应当是库内文件路径；这里会按 `kind` 再筛一遍，避免调用方漏筛） */
  files: readonly string[]
  /** 搜索框里的占位提示 */
  title?: string
  /**
   * 候选类别，决定弹窗自己的二次筛选（`listImagePaths` / `listBundlePaths`）。
   *
   * **必填**：这里刻意**不给缺省值**。缺省值正是这条缺陷的温床 ——
   * 以前这里根本没有这个字段，筛选写死成图片；"导入定义文件"把 `.json` 候选交给它之后
   * **全被图片白名单筛掉**，选择器里一个候选都没有，用户看到的现象是"导入定义的 UI 不工作"。
   * 必填之后，"忘记声明类别"在 TypeScript 调用点上**写不出来**（同 §5.27 的做法）。
   * 教训见 `docs/ENGINEERING-NOTES.md` §5.30。
   */
  kind: AssetPickerKind
  /** 用户选中一项（或回车确认）时回调；取消/关闭不会调用 */
  onChoose: (path: string) => void
}

/** 搜索框占位文案：按类别给；调用方显式传了 `title` 就以它为准 */
function defaultPickerPlaceholder(kind: AssetPickerKind): string {
  return kind === 'bundle' ? '选择定义文件…' : '选择库内图片…'
}

/** 弹窗工厂：默认用真实的 `AssetSuggestModal`，测试里可替换 */
export type ImagePickerFactory = (app: App, options: AssetPickerOptions) => { open(): void }

export class AssetSuggestModal extends FuzzySuggestModal<string> {
  private readonly options: AssetPickerOptions

  constructor(app: App, options: AssetPickerOptions) {
    super(app)
    this.options = options
    this.setPlaceholder(options.title ?? defaultPickerPlaceholder(options.kind))
  }

  /**
   * 只列**该类别**允许的文件（筛选、去重、确定排序都在纯函数里，与调用方同一份实现）。
   *
   * 这里必须按 `kind` 分流：写死图片白名单会让定义文件的选择器恒为空（见 `AssetPickerOptions.kind`）。
   */
  override getItems(): string[] {
    return (this.options.kind === 'bundle' ? listBundlePaths : listImagePaths)(this.options.files)
  }

  /** 显示成 `forest.png · Assets/地形`：同名文件也能分辨 */
  override getItemText(item: string): string {
    return describeAssetChoice(item)
  }

  override onChooseItem(item: string): void {
    this.options.onChoose(item)
  }
}
