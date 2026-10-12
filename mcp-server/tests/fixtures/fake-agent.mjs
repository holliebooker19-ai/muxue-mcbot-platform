// 假 agent：模拟 `claude -p --input-format stream-json --output-format stream-json`，给 companion.mjs 的测试用。
// 环境变量：FAKE_AGENT_LOG 收到的每条消息追加到这个文件（JSON 行，带 pid）；
//           FAKE_AGENT_MODE = ok（默认，正常结束每一轮）| error（每轮 is_error，像额度用完）| crash（启动就退出）
//           FAKE_AGENT_TOKENS 每次回复带的上下文大小（usage），默认 1000
//           FAKE_AGENT_MEMORY 记忆目录（<memory>/xiaoke）：收到【整理记忆】时写 state.json，假装整理完成
//           FAKE_AGENT_CONSOLIDATE = ok（默认）| noop（整理轮不写 state，像没带 through）| quota-once（第一次整理轮报额度错误）
//                                  | crash-once（第一次整理轮直接退出）
//           FAKE_AGENT_CHAT_QUOTA=once 第一次带【游戏事件】的轮报额度错误（Claude 会话额度的说法），没动工具
//           FAKE_AGENT_IGNORE_CLOSE=1 stdin 关了也不退出（测试强制结束进程树）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const mode = process.env.FAKE_AGENT_MODE || 'ok';
const logFile = process.env.FAKE_AGENT_LOG;
const memoryDir = process.env.FAKE_AGENT_MEMORY;
const consolidate = process.env.FAKE_AGENT_CONSOLIDATE || 'ok';
const record = (obj) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...obj }) + '\n'); };
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
// 「第一次」要跨进程算：记在日志目录的标记文件里
const onceFlag = logFile ? `${logFile}.${consolidate}.done` : null;
const firstTime = (flag = onceFlag) => {
  if (!flag || fs.existsSync(flag)) return false;
  fs.writeFileSync(flag, '');
  return true;
};
const chatQuotaFlag = logFile && process.env.FAKE_AGENT_CHAT_QUOTA === 'once' ? `${logFile}.chat-quota.done` : null;

record({ kind: 'start', argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null });
if (mode === 'crash') {
  process.stderr.write('fake crash\n');
  process.exit(1);
}

const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : `fake-session-${process.pid}`;
const tokens = Number(process.env.FAKE_AGENT_TOKENS) || 1000;
emit({ type: 'system', subtype: 'init', session_id: sessionId });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const text = String(msg.message.content);
  record({ kind: 'turn', text });
  const isConsolidate = text.includes('【整理记忆】');
  if (isConsolidate && consolidate === 'crash-once' && firstTime()) {
    record({ kind: 'crash' });
    process.exit(1);
  }
  if (chatQuotaFlag && text.includes('【游戏事件】') && firstTime(chatQuotaFlag)) {
    emit({ type: 'result', is_error: true, subtype: 'success', result: "You've hit your session limit" });
    return;
  }
  const quota = mode === 'error' || (isConsolidate && consolidate === 'quota-once' && firstTime());
  // 工具结果回来一次，再出最终回复
  emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
  if (quota) {
    emit({ type: 'result', is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1790000000' });
    return;
  }
  if (isConsolidate && memoryDir && consolidate !== 'noop') {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'state.json'), JSON.stringify({ consolidatedAt: Date.now() }));
  }
  emit({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: '\x1b[1m好的\x1b[0m' }, { type: 'tool_use', name: 'mcp__minecraft__send-chat', input: { message: '嗯' } }] } });
  emit({ type: 'result', is_error: false, subtype: 'success', result: 'ok', total_cost_usd: 0.001 });
});
rl.on('close', () => {
  record({ kind: 'stdin_closed' });
  if (process.env.FAKE_AGENT_IGNORE_CLOSE === '1') {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});
