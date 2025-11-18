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

const CHECKBOX_RE = /^\s*(?:[*-]|\d+\.)\s*\[( |x|X)\]\s+(.*)$/;

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
    percent: checklist.total === 0 ? 0 : Math.round((checklist.checked / checklist.total) * 100),
  } as const;
}
