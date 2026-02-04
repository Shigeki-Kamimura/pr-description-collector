/**
 * markdown-it-task-lists は TypeScript の型定義（@types）が提供されていないため、
 * このプロジェクト内で最低限の型（プラグイン関数のシグネチャ）を補う。
 *
 * 目的:
 * - strict/型チェックを維持しつつ、import で暗黙の any になるのを防ぐ。
 */
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  type TaskListOptions = {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  };

  const plugin: (md: MarkdownIt, options?: TaskListOptions) => void;
  export default plugin;
}
