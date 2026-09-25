import assert from 'node:assert/strict';
import test from 'node:test';
import { EMAIL_THEMES, buildMailPreview, renderMail } from '../server/mail-template.js';

const appUrl = 'https://couple.example.test';
const taskUrl = `${appUrl}/?page=tasks&task=5c30f052-76df-4c1b-b766-6dab9ab7f601`;
const base = {
  subject: '对方认真完成的小事',
  body: `完成「准备野餐」，奖励 30 积分。\n\n打开两个人：${taskUrl}`,
  kind: 'TASK_SUBMITTED',
  appUrl,
  recipientName: '小满',
};

const kinds = [
  'TASK_CREATED',
  'TASK_PUBLISHED',
  'TASK_CLAIMED',
  'TASK_SUBMITTED',
  'TASK_APPROVED',
  'TASK_REJECTED',
  'ORDER_CREATED',
  'ORDER_FULFILLED',
  'ORDER_COMPLETED',
  'ORDER_CANCELLED',
  'VERIFY_EMAIL',
  'PASSWORD_RESET',
  'PAIRED',
  'GENERAL',
];

test('全部邮件主题及通知种类都保留完整业务内容和可读的操作按钮', () => {
  assert.deepEqual(
    EMAIL_THEMES.map((theme) => theme.id),
    [
      'strawberry',
      'cream',
      'mint',
      'sky',
      'lavender',
      'night',
      'line-puppy',
      'lulu',
      'nailong',
      'yibubu',
      'tom-jerry',
    ],
  );
  const previews = new Set<string>();
  for (const theme of EMAIL_THEMES) {
    assert.match(theme.accent, /^#[\da-f]{6}$/i);
    assert.match(theme.background, /^#[\da-f]{6}$/i);
    for (const kind of kinds) {
      const { html, text } = renderMail({ ...base, theme: theme.id, kind });
      assert.ok(html.includes(base.subject), `${theme.id}/${kind} needs its subject`);
      assert.ok(html.includes('完成「准备野餐」，奖励 30 积分。'));
      assert.ok(html.includes('小满，你好呀'));
      assert.ok(html.includes(theme.accent));
      assert.ok(html.includes(theme.background));
      assert.ok(html.includes('max-width:600px'));
      assert.match(html, /<a href="https:\/\/couple\.example\.test\/\?page=tasks&amp;task=/);
      assert.match(html, /font-weight:700;[^>]*>[^<]+→<\/a>/);
      assert.doesNotMatch(html, /<(?:script|iframe|img|link)\b/i);
      assert.equal(text, base.body);
    }
    previews.add(buildMailPreview(theme.id));
  }
  assert.equal(
    previews.size,
    EMAIL_THEMES.length,
    'each theme must produce its own visual styling',
  );
});

test('主题仅改变样式，安全动作链接及纯文字内容保持一致', () => {
  const expectedLinks = renderMail({ ...base }).html.match(/href="[^"]+"/g);
  for (const theme of EMAIL_THEMES) {
    const rendered = renderMail({ ...base, theme: theme.id });
    assert.equal(rendered.text, base.body);
    assert.deepEqual(rendered.html.match(/href="[^"]+"/g), expectedLinks);
  }
  assert.deepEqual(
    renderMail({ ...base, theme: 'unknown-theme' }),
    renderMail({ ...base, theme: 'strawberry' }),
  );
  const unknownEvent = renderMail({ ...base, kind: '<script>unknown()</script>' });
  assert.ok(unknownEvent.html.includes('两个人的小空间有了新消息'));
  assert.doesNotMatch(unknownEvent.html, /<script>/);
  for (const kind of ['__proto__', 'constructor', 'toString']) {
    assert.ok(renderMail({ ...base, kind }).html.includes('两个人的小空间有了新消息'));
  }
});

test('昵称、标题、正文与链接属性全部转义，不生成动态 HTML', () => {
  const rendered = renderMail({
    ...base,
    subject: '<script>alert("subject")</script> & 心意',
    recipientName: '<img src=x onerror="alert(1)">',
    body: '<svg onload="alert(2)">\n\n对方说：\'好呀\' & 明天见',
  });
  assert.ok(rendered.html.includes('&lt;script&gt;alert(&quot;subject&quot;)&lt;/script&gt;'));
  assert.ok(rendered.html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(rendered.html.includes('&lt;svg onload=&quot;alert(2)&quot;&gt;'));
  assert.ok(rendered.html.includes('&#39;好呀&#39; &amp; 明天见'));
  assert.doesNotMatch(rendered.html, /<(?:script|svg|img)\b/i);
  assert.equal(rendered.text, '<svg onload="alert(2)">\n\n对方说：\'好呀\' & 明天见');
});

test('正文中的不安全地址不会成为可点击动作链接', () => {
  for (const candidate of [
    'javascript:alert(1)',
    'data:text/html,bad',
    'https://other.example.test/steal',
    'https://couple.example.test.evil.test/',
    'https://user:password@couple.example.test/',
    'http://couple.example.test/',
    'https://couple.example.test:8443/',
    '//other.example.test/steal',
  ]) {
    const body = `消息保持完整。\n\n打开两个人：${candidate}`;
    const { html, text } = renderMail({ ...base, body });
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(links, [`${appUrl}/`, `${appUrl}/`], candidate);
    assert.ok(html.includes('消息保持完整。'));
    assert.equal(text, body);
  }
  const invalidBase = renderMail({ ...base, appUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(invalidBase.html, /href=/);
  assert.equal(invalidBase.text, base.body);
});

test('邮箱验证链接及任务、订单深链接完整保留，支持本地 HTTP', () => {
  const verifyUrl = `${appUrl}/?verify=${'abc123'.repeat(10)}&source=email`;
  const verifyBody = `请打开以下链接验证邮箱，链接一小时内有效：\n${verifyUrl}\n\n若不是你的操作，请忽略。`;
  const verification = renderMail({ ...base, kind: 'VERIFY_EMAIL', body: verifyBody });
  assert.ok(verification.html.includes('验证我的邮箱'));
  assert.ok(verification.html.includes('链接一小时内有效'));
  assert.ok(verification.html.includes(verifyUrl.replace('&', '&amp;')));
  assert.equal(verification.text, verifyBody);

  const unsafeVerify = renderMail({
    ...base,
    kind: 'VERIFY_EMAIL',
    body: '请验证：\nhttps://external.example.test/?verify=stolen',
  });
  assert.doesNotMatch(unsafeVerify.html, /href="https:\/\/external/);
  assert.doesNotMatch(unsafeVerify.html, />验证我的邮箱/);

  const orderUrl = 'http://localhost:33442/?page=shop&tab=orders';
  const order = renderMail({
    ...base,
    kind: 'ORDER_CREATED',
    appUrl: 'http://localhost:33442',
    body: `心意已被兑换。\n\n打开两个人：${orderUrl}`,
  });
  assert.ok(order.html.includes('href="http://localhost:33442/?page=shop&amp;tab=orders"'));
  assert.ok(order.html.includes('查看待兑现心意'));
});

test('邮箱中的多段正文和换行不丢失，纯文字版本完全沿用原邮件', () => {
  const body = '第一段：任务完成，30 积分。\r\n继续说明。\r\n\r\n第二段：记得带伞。';
  const rendered = renderMail({ ...base, body, recipientName: '' });
  assert.equal(rendered.text, body);
  assert.ok(rendered.html.includes('第一段：任务完成，30 积分。<br>继续说明。'));
  assert.ok(rendered.html.includes('第二段：记得带伞。'));
  assert.ok(rendered.html.includes('嗨，收好这封小信'));
});

test('密码恢复邮件主按钮保留片段令牌，并采用账号安全提示', () => {
  const resetUrl = `${appUrl}/#reset-password=${'a'.repeat(64)}`;
  const body = `请设置新密码，链接 30 分钟内有效：\n${resetUrl}\n\n重置后所有设备都需要重新登录。`;
  const mail = renderMail({ ...base, kind: 'PASSWORD_RESET', body });
  assert.ok(mail.html.includes(`href="${resetUrl}"`));
  assert.ok(mail.html.includes('重置登录密码'));
  assert.ok(mail.html.includes('这是账号安全邮件'));
  assert.ok(mail.html.includes('30 分钟内有效'));
  assert.equal(mail.text, body);
  assert.doesNotMatch(mail.html, /邮件提醒可以在/);
  const unsafe = renderMail({
    ...base,
    kind: 'PASSWORD_RESET',
    body: '重置链接：\nhttps://evil.example/#reset-password=stolen',
  });
  assert.doesNotMatch(unsafe.html, /href="https:\/\/evil/);
  assert.doesNotMatch(unsafe.html, />重置登录密码/);
});
