# 归档（docs/archive）· 只读

> **这里放的是历史，不是现状。** 需要"现在怎么用 / 现在做什么"请回上级目录：
> `PLAN.md`（排期）· `DEVLOG.md`（已完成流水）· `HANDOFF.md`（交接入口）·
> `EXTENSION-POINTS.md`（怎么加）· `ENGINEERING-NOTES.md`（为什么）。

| 文件 | 是什么 | 谁还会引用它 |
|---|---|---|
| `PHASE-0-RESULTS.md` | Obsidian 1.13.7 上的**私有 Canvas API 实测数据**（矩阵/量化/事件/挂载点）—— 全项目"实测而非猜测"的权威出处 | `src/core/projection.ts`、`tests/projection.test.ts`、`scripts/smoke.mjs` 的桩复刻都以它为依据（**别删**） |
| `PHASE-1-NOTES.md` | Phase 1 的实施决定与教训（含"新人先读"的判断方式 §31–§37） | `ENGINEERING-NOTES.md` §5.7 等 |
| `PHASE-3-BASE-VIEW.md` | Base 视图的设计决定、已知风险、未验证项 | `ENGINEERING-NOTES.md` 状态表 |
| `TECHNICAL-DESIGN-v2.md` | 早期技术方案（含 17 条原始假设的勘误表） | `ENGINEERING-NOTES.md` 文件入口表 |
| `ARCHIVE-HANDOFF.md` | 2026-09-24 ～ 09-28 的**逐轮交接叙事原文**（含各轮"未接线 / 未验证"清单） | `PLAN.md` §2 / P0 提到"未验证项以逐轮记录为准" |

**规矩**

- 这些文件**不再更新**：新东西写进 `DEVLOG.md`（已完成）或 `PLAN.md`（排期）。
- 搬进来时已把全仓引用改成 `archive/…` 或 `docs/archive/…`；**改文件名或再搬家要同步引用**
  （`src/core/projection.ts`、`tests/projection.test.ts`、`scripts/smoke.mjs`、`README.md`、
  `docs/ENGINEERING-NOTES.md` 都在引用它们）。
- 真要删某一份之前，先确认没有代码/测试把它当作**依据出处**（`PHASE-0-RESULTS.md` 就属于这种）。
