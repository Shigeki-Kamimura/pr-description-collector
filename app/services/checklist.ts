// チェックリスト解析ユーティリティ（Markdownのチェックボックスを抽出）

export type ChecklistItem = {
  checked: boolean;
  text: string;
  line: number;
};

export type Checklist = {
  items: ChecklistItem[];
  total: number;
  checked: number;
};

/**
 * CHECKBOX_RE 正規表現の各部分の説明:
 *   ^\s*                : 行頭の空白（任意）
 *   (?:[*-]|\d+\.)      : リストマーカー（* または - または 数字.）
 *   \s*                 : マーカー後の空白（任意）
 *   \[( |x|X)\]         : チェックボックス状態（[ ] または [x] または [X]）
 *   \s*                 : チェックボックス後の空白（任意）
 *   (.*)                : チェックボックス後のテキスト（任意の文字列）
 *   $                   : 行末
 */
const CHECKBOX_RE = /^\s*(?:[*-]|\d+\.)\s*\[( |x|X)\]\s*(.*)$/;

export function parseChecklist(input: string): Checklist {
  const items: ChecklistItem[] = [];
  const lines = input.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const m = line.match(CHECKBOX_RE);
    if (!m) return;
    const checked = m[1].toLowerCase() === "x";
    const text = m[2].trim();
    items.push({ checked, text, line: idx + 1 });
  });

  const total = items.length;
  const checked = items.filter((i) => i.checked).length;
  return { items, total, checked };
}

export function summarize(checklist: Checklist) {
  return {
    total: checklist.total,
    checked: checklist.checked,
    // パーセンテージ計算をより明示的に（整数除算の誤解を防ぐ）
    percent: checklist.total === 0 ? 0 : Math.floor((100 * checklist.checked) / checklist.total),
  } as const;
}
