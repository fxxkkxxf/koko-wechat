const STYLE_START = '【微信消息节奏】';
const STYLE_END = '【/微信消息节奏】';

export const CHAT_BUBBLE_STYLE = `${STYLE_START}
这一节只调整说话长短和消息边界；关于表达节奏，以本节为准，隐私、事实、接话范围和安全要求仍然有效。
像熟人在微信里聊天：一个自然的小意思发一条，想到下一句再接，不把日常回应写成一整段讲解或总结。
普通闲聊每条以六到七个汉字为大致节奏，多数在五到九个字之间。不是字数考核：反问、语气词、专有名词可以自然稍长；一句已经够了就只发一句。
一轮通常一到三条，确实需要时最多四条。不为凑条数补无意义的话，不把一个词、数字、网址或一句尚未说完整的话硬拆开。
reply 字符串内容中的换行表示一条独立微信消息的边界；仍按原 JSON 格式返回，不新增字段，不输出气泡编号、分隔线或“第一条”等标签。应用会按这些边界依次发送。
解释原因、讲步骤、认真讨论、回答资料问题或用户明确要求详细时，可以发一到三条较长而完整的消息，把内容说清楚。代码、列表、引用、网址保持完整，不为了六七个字破坏结构。
语气自然，不每句都写完整书面句号，不反复叫对方名字，不套客服开场，也不靠故意错字、漏字、重复语气词来装真人。保留原角色性格，跟随当下情绪和话题。
节奏示例（只学语气，不要每次照抄）：
对方说“今天好累”，可以回复“今天忙了一天吧”换行“先坐下来歇歇”换行“我陪你聊一会”。
对方说“帮我看看这个”，可以回复“发过来我看看”换行“我先帮你捋捋”。
如果只是确认，直接“好，我记住啦”也可以；如果要讲清楚一个复杂问题，允许保留完整长句。
${STYLE_END}`;

/** Keep one visible, editable style section when the settings are saved repeatedly. */
export function withReplyStyle(persona = '') {
  const value = typeof persona === 'string' ? persona : '';
  const escapedStart = STYLE_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = STYLE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'g');
  const cleaned = value.replace(existing, '').trim();
  return (cleaned ? cleaned + '\n\n' : '') + CHAT_BUBBLE_STYLE;
}

const listLine = line => /^\s*(?:[-*+•]\s+|\d+[.)、]\s*|[一二三四五六七八九十]+[、.．]\s*|[①-⑳]\s*)/u.test(line);
const indentedLine = line => /^(?: {2,}|\t)\S/.test(line);
const tableLine = line => /^\s*\|.*\|\s*$/.test(line);
const quoteLine = line => /^\s*>/.test(line);
const sourceHeading = line => /^\s*(?:来源|参考来源|参考资料|参考链接|相关链接|Sources?)\s*[:：]?\s*$/iu.test(line);
const urlLine = line => /^\s*(?:https?:\/\/\S+|\[[^\]]+\]\(https?:\/\/[^)]+\))\s*$/iu.test(line);
const fenceStart = line => line.match(/^\s*(`{3,}|~{3,})/);

function looksLikeJSON(value) {
  if (!/^[\[{]/.test(value) || !/[\]}]$/.test(value)) return false;
  try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === 'object'; }
  catch { return false; }
}

/**
 * Newlines are semantic bubble boundaries authored by the model. This function
 * never cuts by character count. Structured blocks stay intact, and overflow
 * is joined into the final bubble instead of dropping or truncating content.
 */
export function splitReplyMessages(reply, {maxMessages = 4} = {}) {
  if (typeof reply !== 'string') return [];
  const text = reply.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const numericLimit = Number(maxMessages);
  const limit = Number.isFinite(numericLimit) ? Math.max(1, Math.min(4, Math.floor(numericLimit))) : 4;
  if (looksLikeJSON(text)) return [text];
  const lines = text.split('\n');
  const messages = [];
  let i = 0;
  const push = block => { const message = block.join('\n').trim(); if (message) messages.push(message); };

  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const line = lines[i];
    const fence = fenceStart(line);
    if (fence) {
      const block = [line]; i++;
      const marker = fence[1][0], count = fence[1].length;
      const close = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${count},}\\s*$`);
      while (i < lines.length) { const next = lines[i++]; block.push(next); if (close.test(next)) break; }
      push(block); continue;
    }
    if (listLine(line) || tableLine(line) || quoteLine(line)) {
      const kind = listLine(line) ? 'list' : tableLine(line) ? 'table' : 'quote';
      const matches = kind === 'list' ? listLine : kind === 'table' ? tableLine : quoteLine;
      const block = [line]; i++;
      while (i < lines.length) {
        const next = lines[i];
        if (matches(next) || kind === 'list' && indentedLine(next)) { block.push(next); i++; continue; }
        if (!next.trim()) {
          let after = i + 1; while (after < lines.length && !lines[after].trim()) after++;
          if (after < lines.length && matches(lines[after])) { block.push(...lines.slice(i, after)); i = after; continue; }
        }
        break;
      }
      // Keep a preceding explanation/heading with its structured content.
      if (messages.length && /[:：]$/.test(messages.at(-1))) block.unshift(messages.pop());
      push(block); continue;
    }
    if (sourceHeading(line) || urlLine(line)) {
      const block = [line]; i++;
      while (i < lines.length && urlLine(lines[i])) block.push(lines[i++]);
      push(block); continue;
    }
    // A plain one-line reply or long explanation is already one complete unit.
    push([line]); i++;
  }
  if (messages.length <= limit) return messages;
  return [...messages.slice(0, limit - 1), messages.slice(limit - 1).join('\n')];
}
