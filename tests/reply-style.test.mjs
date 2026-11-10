import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAT_BUBBLE_STYLE, withReplyStyle, splitReplyMessages} from '../lib/reply-style.mjs';

test('style section states a flexible six-to-seven character cadence and real bubble boundaries', () => {
  assert.match(CHAT_BUBBLE_STYLE, /六到七个/);
  assert.match(CHAT_BUBBLE_STYLE, /最多四条/);
  assert.match(CHAT_BUBBLE_STYLE, /可以发一到三条较长而完整/);
  assert.match(CHAT_BUBBLE_STYLE, /不把一个词、数字、网址/);
});

test('saving style repeatedly is idempotent and leaves the private persona intact', () => {
  const original = '可可的角色设定。\n私人信息不得带到群聊。';
  const once = withReplyStyle(original);
  assert.equal(withReplyStyle(once), once);
  assert.equal(withReplyStyle(once + '\n\n' + CHAT_BUBBLE_STYLE), once);
  assert.ok(once.startsWith(original));
  assert.equal((once.match(/【微信消息节奏】/g) || []).length, 1);
  assert.equal(withReplyStyle(null), CHAT_BUBBLE_STYLE);
});

test('casual lines become distinct messages without padding or forced length cuts', () => {
  assert.deepEqual(splitReplyMessages('今天忙了一天吧\n先坐下来歇歇\n我陪你聊一会'), ['今天忙了一天吧', '先坐下来歇歇', '我陪你聊一会']);
  assert.deepEqual(splitReplyMessages('嗯嗯'), ['嗯嗯']);
  assert.deepEqual(splitReplyMessages('这是一个内容完整的较长句子，不能为了凑六七个字把意思拆坏。'), ['这是一个内容完整的较长句子，不能为了凑六七个字把意思拆坏。']);
});

test('newlines, blank boundaries and emoji are handled without slicing Unicode characters', () => {
  assert.deepEqual(splitReplyMessages('  收到啦 👨‍👩‍👧‍👦\r\n\r\n先让我想想🤔\r这就帮你看看  '), ['收到啦 👨‍👩‍👧‍👦', '先让我想想🤔', '这就帮你看看']);
  assert.deepEqual(splitReplyMessages('\n\n'), []);
  assert.deepEqual(splitReplyMessages(undefined), []);
});

test('excess lines are merged into the last message with all content retained', () => {
  const input = '第一句\n第二句\n第三句\n第四句\n第五句\n第六句';
  const messages = splitReplyMessages(input);
  assert.deepEqual(messages, ['第一句', '第二句', '第三句', '第四句\n第五句\n第六句']);
  assert.equal(messages.join('\n'), input);
  assert.deepEqual(splitReplyMessages(input, {maxMessages:2}), ['第一句', '第二句\n第三句\n第四句\n第五句\n第六句']);
  assert.deepEqual(splitReplyMessages(input, {maxMessages:1}), [input]);
  assert.equal(splitReplyMessages(input, {maxMessages:20}).length, 4);
});

test('long explanatory paragraphs stay complete while allowing separate paragraphs', () => {
  const first = '如果你想提高引体向上的次数，先把每次动作做完整，再根据当天状态控制训练量。';
  const second = '休息时间不必刻意缩短，动作明显变慢或肩肘不舒服时，应停止这次训练。';
  assert.deepEqual(splitReplyMessages(first + '\n\n' + second), [first, second]);
});

test('fenced code stays one message and a malformed unclosed block is not chopped', () => {
  const code = '```js\nconst a = "你好\\n世界";\nconsole.log(a);\n```';
  assert.deepEqual(splitReplyMessages('可以这样写\n' + code + '\n再试一下'), ['可以这样写', code, '再试一下']);
  const unclosed = '```\n第一行\n第二行\n第三行\n第四行';
  assert.deepEqual(splitReplyMessages(unclosed), [unclosed]);
  assert.deepEqual(splitReplyMessages('~~~text\n一\n二\n~~~'), ['~~~text\n一\n二\n~~~']);
});

test('numbered lists, table rows, quotes and their colon heading retain structure', () => {
  const steps = '可以这样做：\n1. 先确认参数\n2. 再保存设置\n   保留原来的配置\n\n3. 最后测试';
  assert.deepEqual(splitReplyMessages(steps + '\n就这么几步'), [steps, '就这么几步']);
  const table = '| 项目 | 数值 |\n| --- | --- |\n| A | 7 |';
  assert.deepEqual(splitReplyMessages(table), [table]);
  const quote = '> 这一段是引用\n> 下一行仍是引用';
  assert.deepEqual(splitReplyMessages(quote), [quote]);
});

test('URLs and a source list stay whole including their query parameters', () => {
  const url = 'https://example.com/documentation?q=hello%20world&section=7#content';
  const sources = '来源：\n' + url + '\nhttps://example.org/long-path';
  assert.deepEqual(splitReplyMessages('查到这些资料\n' + sources), ['查到这些资料', sources]);
  assert.deepEqual(splitReplyMessages('你可以看这个：' + url), ['你可以看这个：' + url]);
});

test('JSON text and literal escaped newline artifacts are preserved rather than decoded', () => {
  const json = '{\n  "message": "你好\\n世界",\n  "number": 1234567\n}';
  assert.deepEqual(splitReplyMessages(json), [json]);
  assert.deepEqual(splitReplyMessages('第一句\\n第二句'), ['第一句\\n第二句']);
});
