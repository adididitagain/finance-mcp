/** Number / date formatting shared by every tool's text output. */

export function money(value: number | null | undefined, currency = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const digits = Math.abs(value) < 1 ? 6 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

export function num(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

/** 1_234_567_890 -> "1.23B" */
export function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${(value / size).toFixed(2)}${suffix}`;
  }
  return num(value);
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function signed(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

export function isoDate(epochSeconds: number | null | undefined): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return "n/a";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function isoDateTime(epochSeconds: number | null | undefined): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return "n/a";
  return new Date(epochSeconds * 1000).toISOString().replace(".000", "");
}

/** Render an aligned markdown-style table. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = rows.map((r) => r.map((c) => String(c)));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length), 3),
  );
  const line = (values: string[]) =>
    "| " + values.map((v, i) => v.padEnd(widths[i])).join(" | ") + " |";
  return [
    line(headers),
    "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|",
    ...cells.map(line),
  ].join("\n");
}
