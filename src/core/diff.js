export function fileDiff(file, before, after) {
  const oldLines = before.split('\n'); const newLines = after.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length; let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  return [`--- a/${file}`, `+++ b/${file}`, `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`,
    ...oldLines.slice(start, oldEnd).map((line) => '-' + line), ...newLines.slice(start, newEnd).map((line) => '+' + line)].join('\n');
}
