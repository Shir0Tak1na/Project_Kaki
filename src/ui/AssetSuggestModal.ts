/**
 * 「从库里选一张图片」的弹窗。
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
import { describeAssetChoice, listImagePaths } from '../base/assetFiles.ts'

export interface AssetPickerOptions {
  /** 候选路径（应当是库内文件路径；这里会再筛一遍，避免调用方漏筛） */
  files: readonly string[]
  /** 搜索框里的占位提示 */
  title?: string
  /** 用户选中一项（或回车确认）时回调；取消/关闭不会调用 */
  onChoose: (path: string) => void
}

/** 弹窗工厂：默认用真实的 `AssetSuggestModal`，测试里可替换 */
export type ImagePickerFactory = (app: App, options: AssetPickerOptions) => { open(): void }

export class AssetSuggestModal extends FuzzySuggestModal<string> {
  private readonly options: AssetPickerOptions

  constructor(app: App, options: AssetPickerOptions) {
    super(app)
    this.options = options
    this.setPlaceholder(options.title ?? '选择库内图片…')
  }

  /** 只列图片（筛选、去重、确定排序都在纯函数里） */
  override getItems(): string[] {
    return listImagePaths(this.options.files)
  }

  /** 显示成 `forest.png · Assets/地形`：同名文件也能分辨 */
  override getItemText(item: string): string {
    return describeAssetChoice(item)
  }

  override onChooseItem(item: string): void {
    this.options.onChoose(item)
  }
}
