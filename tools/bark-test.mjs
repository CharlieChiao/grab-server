// Bark 铃声测试脚本(本地运行, 不走服务器)
//
// 用法:
//   node tools/bark-test.mjs "<Bark App 复制的链接或 Key>"             # 默认铃声 anticipate
//   node tools/bark-test.mjs "<Key或链接>" bell                        # 指定铃声(输入什么发什么, 不校验)
//   node tools/bark-test.mjs "<Key或链接>" --list                      # 列出全部可选铃声
//
// 第一个参数支持任何形态: 纯 Key / https://api.day.app/KEY / curl 命令(直接整段粘贴 App 里复制的内容)

const SOUNDS = [
  "alarm", "anticipate", "bell", "birds", "bloom", "calypso", "chime", "choo", "descent",
  "electronic", "fanfare", "glass", "gotosleep", "healthnotification", "huron", "infantil",
  "jump", "leaves", "metal", "multicastnotification", "paymentsuccess", "shake", "sherwood",
  "silence", "spell", "suspen", "telegraph", "tiptoes", "typewriter", "update",
];

// 与服务器 extractBarkInput 同规则的本地解析
function extractKey(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/https?:\/\/([^/\s"'`]+)\/([A-Za-z0-9_-]{20,64})(?:[/?\s"'`]|$)/);
  if (m) return { key: m[2], server: /^api\.day\.app$/.test(m[1]) ? "https://api.day.app" : `https://${m[1]}` };
  if (/^[A-Za-z0-9_-]{20,64}$/.test(s)) return { key: s, server: "https://api.day.app" };
  return null;
}

const [input, sound, title, body] = process.argv.slice(2);

if (!input || input === "--help" || input === "-h") {
  console.log("用法: node tools/bark-test.mjs \"<Bark App 复制的链接或 Key>\" [铃声名] [标题] [内容]");
  console.log(`参考铃声(${SOUNDS.length} 个):`);
  console.log("  " + SOUNDS.join(", "));
  process.exit(0);
}
if (input === "--list") { console.log(SOUNDS.join("\n")); process.exit(0); }

const parsed = extractKey(input);
if (!parsed) { console.error("未识别出 Key——请粘贴 Bark App 首页\"复制\"的完整链接, 或纯 Key"); process.exit(1); }

// 铃声名不做校验, 输入什么发什么(未知铃声 Bark 会用默认音)
const chosen = sound || "anticipate";

const payload = {
  device_key: parsed.key,
  title: title || `铃声测试 · ${chosen}`,
  body: body || "听到这个提示音, 说明该铃声可用。",
  group: "铃声测试",
  sound: chosen,
};

console.log(`发送 → ${parsed.server}/push  sound=${chosen}`);
const res = await fetch(`${parsed.server}/push`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const json = await res.json().catch(() => null);
console.log(`HTTP ${res.status}`, JSON.stringify(json));
if (json?.code !== 200) process.exit(1);
console.log("已送达, 听一下你的 iPhone。");
