// 在 Git Bash (Windows) 下，Node.js stdout 连接为 pipe 时默认缓冲输出。
// setBlocking(true) 让每次写入即时刷新，避免下载进度等日志需要回车才显示。
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);

export function header(title, version, rows = []) {
  console.log(`${title} ${version}`);
  console.log("");
  for (const row of rows) console.log(row);
  if (rows.length) console.log("");
}

export function step(index, total, title) {
  console.log(`[${index}/${total}] ${title}`);
}

export function ok(message) {
  console.log(`通过：${message}`);
}

export function warn(message) {
  console.warn(`提示：${message}`);
}

export function skip(message) {
  console.log(`跳过：${message}`);
}

export function fail(message) {
  console.log(`失败：${message}`);
}

export function action(message) {
  console.log(message);
}

export function blank() {
  console.log("");
}

export function shortSha(value) {
  return value ? value.slice(0, 7) : "";
}

