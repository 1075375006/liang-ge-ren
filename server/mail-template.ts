export const EMAIL_THEMES = [
  {
    id: 'strawberry',
    name: '草莓心事',
    description: '莓果粉与小爱心，把日常写成一封甜甜的信。',
    emoji: '🍓',
    accent: '#B7395D',
    background: '#FFF0F3',
  },
  {
    id: 'cream',
    name: '奶油来信',
    description: '暖奶油色的小信纸，装下一点温柔和小确幸。',
    emoji: '🧁',
    accent: '#855723',
    background: '#FFF6E7',
  },
  {
    id: 'mint',
    name: '薄荷花园',
    description: '清新的绿叶边框，陪你们慢慢收集好日常。',
    emoji: '🌿',
    accent: '#26715A',
    background: '#EDF8F1',
  },
  {
    id: 'sky',
    name: '云朵邮局',
    description: '把小约定寄上蓝天，让柔软的云朵送到身边。',
    emoji: '☁️',
    accent: '#2F6597',
    background: '#EDF6FF',
  },
  {
    id: 'lavender',
    name: '紫色花笺',
    description: '淡紫花朵与虚线信封，留住认真对待彼此的心意。',
    emoji: '🪻',
    accent: '#7655A3',
    background: '#F4EFFB',
  },
  {
    id: 'night',
    name: '晚安星河',
    description: '深蓝夜空和暖金小星星，把今天的心意悄悄点亮。',
    emoji: '🌙',
    accent: '#E8C780',
    background: '#131A30',
  },
] as const;

export type EmailTheme = (typeof EMAIL_THEMES)[number]['id'];

type Palette = {
  card: string;
  header: string;
  ink: string;
  muted: string;
  border: string;
  buttonInk: string;
  ornament: string;
  ornamentSize: number;
  edge: string;
  label: string;
  note: string;
};

const palettes: Record<EmailTheme, Palette> = {
  strawberry: {
    card: '#FFFFFF',
    header: '#FFE1E9',
    ink: '#51313C',
    muted: '#81616C',
    border: '#F2BCCC',
    buttonInk: '#FFFFFF',
    ornament: '♡ · 🍓 · ♡',
    ornamentSize: 24,
    edge: '6px solid #D96182',
    label: '一颗小心意，寄给你',
    note: '把喜欢，放进每一天。',
  },
  cream: {
    card: '#FFFEFA',
    header: '#F9EBD1',
    ink: '#51412E',
    muted: '#7F6C53',
    border: '#DDCBA9',
    buttonInk: '#FFFFFF',
    ornament: '✿   🧁   ✿',
    ornamentSize: 23,
    edge: '6px double #C7A46C',
    label: '今日份的温柔已送达',
    note: '平凡的小事，也值得好好收藏。',
  },
  mint: {
    card: '#FFFFFF',
    header: '#E0F1E5',
    ink: '#304C40',
    muted: '#607B6D',
    border: '#B4D6C2',
    buttonInk: '#FFFFFF',
    ornament: '🌿    ♧    🌱',
    ornamentSize: 25,
    edge: '5px dotted #78B69A',
    label: '我们的日常，又长大一点',
    note: '一起慢慢来，一起好好生活。',
  },
  sky: {
    card: '#FFFFFF',
    header: '#DDEEFF',
    ink: '#304B65',
    muted: '#637D95',
    border: '#B9D5EC',
    buttonInk: '#FFFFFF',
    ornament: '☁️    ✉    ☁️',
    ornamentSize: 27,
    edge: '7px solid #8FBDDF',
    label: '云朵邮局 · 有你的来信',
    note: '每一份小约定，都有人放在心上。',
  },
  lavender: {
    card: '#FFFDFF',
    header: '#EBE0F8',
    ink: '#514264',
    muted: '#7D6B91',
    border: '#D3C0E8',
    buttonInk: '#FFFFFF',
    ornament: '✾    🪻    ✾',
    ornamentSize: 25,
    edge: '5px dashed #B09ACF',
    label: '给你一封，开着花的小信',
    note: '认真回应，是日常里温柔的浪漫。',
  },
  night: {
    card: '#202B45',
    header: '#293651',
    ink: '#F3EEE4',
    muted: '#C1CBDD',
    border: '#495572',
    buttonInk: '#302B24',
    ornament: '✦    🌙    ✧',
    ornamentSize: 26,
    edge: '5px solid #E8C780',
    label: '星光替你，捎来一份心意',
    note: '今天的小小用心，也在悄悄发光。',
  },
};

const eventCopy: Record<string, { emoji: string; lead: string; button: string }> = {
  TASK_CREATED: {
    emoji: '📝',
    lead: '有一份新约定在等你，看看这次想一起完成什么吧。',
    button: '看看新约定',
  },
  TASK_CLAIMED: {
    emoji: '🙌',
    lead: '小约定已经有人接住啦，来看看新的进展。',
    button: '查看领取进展',
  },
  TASK_SUBMITTED: {
    emoji: '💌',
    lead: '一份用心已经交到你手里，记得回应对方的认真呀。',
    button: '去验收这份用心',
  },
  TASK_APPROVED: {
    emoji: '🌟',
    lead: '认真完成的小事被看见啦，收好这份属于你的鼓励。',
    button: '查看约定与积分',
  },
  TASK_REJECTED: {
    emoji: '🌱',
    lead: '这份约定还差一点点，看看对方留下的小提醒吧。',
    button: '查看修改提醒',
  },
  ORDER_CREATED: {
    emoji: '🎁',
    lead: '对方兑换了一份小心愿，等你一起把期待变成日常。',
    button: '查看待兑现心意',
  },
  ORDER_FULFILLED: {
    emoji: '🫶',
    lead: '期待的小心意已经兑现，收到后记得轻轻说声谢谢。',
    button: '确认收到心意',
  },
  ORDER_COMPLETED: {
    emoji: '💝',
    lead: '这份心意已经被好好收下，又多了一件值得记住的小事。',
    button: '查看心意记录',
  },
  ORDER_CANCELLED: {
    emoji: '🧸',
    lead: '这次的兑换已经取消，积分退还情况可以在记录里查看。',
    button: '查看取消与退款',
  },
  VERIFY_EMAIL: {
    emoji: '✉️',
    lead: '确认一下收信地址，让两个人的小提醒顺利找到你。',
    button: '验证我的邮箱',
  },
  PASSWORD_RESET: {
    emoji: '🔑',
    lead: '为账号换一个安心的新密码，再回来记录你们的日常。',
    button: '重置登录密码',
  },
  PAIRED: {
    emoji: '💕',
    lead: '两个人终于到齐啦，从一个小约定开始你们的日常吧。',
    button: '打开我们的小空间',
  },
  GENERAL: {
    emoji: '💬',
    lead: '两个人的小空间有了新消息，抽空来看看吧。',
    button: '打开两个人',
  },
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });

function safeUrl(value: string, origin?: string): URL | null {
  if (!value || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (origin && url.origin !== origin)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function mailAction(body: string, kind: string, appUrl: string) {
  const base = safeUrl(appUrl);
  if (!base) return { url: null, body, specific: false };
  const trailing = /(?:^|\n)打开两个人[：:]\s*(\S+)\s*$/u.exec(body);
  const candidates = trailing
    ? [{ value: trailing[1], start: trailing.index, length: trailing[0].length }]
    : ['VERIFY_EMAIL', 'PASSWORD_RESET'].includes(kind)
      ? [...body.matchAll(/^[ \t]*(https?:\/\/[^\s<>]+)[ \t]*$/gimu)].map((match) => ({
          value: match[1],
          start: match.index!,
          length: match[0].length,
        }))
      : [];
  for (const candidate of candidates) {
    const url = safeUrl(candidate.value, base.origin);
    if (!url) continue;
    return {
      url: url.toString(),
      body: (
        body.slice(0, candidate.start) + body.slice(candidate.start + candidate.length)
      ).trim(),
      specific: true,
    };
  }
  return { url: base.toString(), body, specific: false };
}

export function renderMail(input: {
  subject: string;
  body: string;
  kind: string;
  theme?: string;
  appUrl: string;
  recipientName?: string;
}): { html: string; text: string } {
  const theme = EMAIL_THEMES.find((item) => item.id === input.theme) ?? EMAIL_THEMES[0];
  const palette = palettes[theme.id];
  const kind = input.kind === 'TASK_PUBLISHED' ? 'TASK_CREATED' : input.kind;
  const copy = Object.hasOwn(eventCopy, kind) ? eventCopy[kind] : eventCopy.GENERAL;
  const action = mailAction(input.body, kind, input.appUrl);
  const greeting = input.recipientName?.trim()
    ? `${input.recipientName.trim()}，你好呀`
    : '嗨，收好这封小信';
  const body = action.body
    .split(/\r?\n[ \t]*\r?\n/u)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px;font-size:16px;line-height:1.85;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`,
    )
    .join('');
  const button =
    ['VERIFY_EMAIL', 'PASSWORD_RESET'].includes(kind) && !action.specific
      ? '打开两个人'
      : copy.button;
  const actionHtml = action.url
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
        <tr><td align="center" bgcolor="${theme.accent}" style="border-radius:14px;background-color:${theme.accent};mso-padding-alt:16px 28px;">
          <a href="${escapeHtml(action.url)}" style="display:inline-block;padding:16px 28px;color:${palette.buttonInk};font-size:16px;line-height:1.35;font-weight:700;text-decoration:none;border-radius:14px;">${escapeHtml(button)} &nbsp;→</a>
        </td></tr>
      </table>
      <p style="margin:20px 0 6px;color:${palette.muted};font-size:12px;line-height:1.7;">按钮打不开时，也可以复制下面的链接到浏览器。</p>
      <p style="margin:0;font-size:12px;line-height:1.7;word-break:break-all;overflow-wrap:anywhere;"><a href="${escapeHtml(action.url)}" style="color:${palette.muted};text-decoration:underline;word-break:break-all;">${escapeHtml(action.url)}</a></p>`
    : `<p style="margin:0;color:${palette.muted};font-size:14px;line-height:1.8;">打开你平时使用的两个人网站，查看这条消息。</p>`;
  const footer =
    kind === 'VERIFY_EMAIL'
      ? '如果这次验证不是你发起的，可以忽略这封邮件。'
      : kind === 'PASSWORD_RESET'
        ? '这是账号安全邮件。如果不是你发起的，可以忽略；你的密码不会改变。'
        : '邮件提醒可以在「我们的空间」中调整；站内通知会为你保留。';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="${theme.id === 'night' ? 'dark' : 'light'}"><title>${escapeHtml(input.subject)}</title></head>
<body data-email-theme="${theme.id}" style="margin:0;padding:0;background-color:${theme.background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;color:${palette.ink};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(copy.lead)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${theme.background}" style="width:100%;background-color:${theme.background};">
    <tr><td align="center" style="padding:28px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
        <tr><td align="center" style="padding:0 12px 20px;color:${palette.ink};font-size:20px;font-weight:700;letter-spacing:2px;">♡ &nbsp;两个人</td></tr>
        <tr><td bgcolor="${palette.card}" style="background-color:${palette.card};border:1px solid ${palette.border};border-top:${palette.edge};border-radius:22px;overflow:hidden;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
            <tr><td align="center" bgcolor="${palette.header}" style="padding:25px 20px 24px;background-color:${palette.header};border-bottom:1px solid ${palette.border};">
              <p aria-hidden="true" style="margin:0 0 12px;color:${theme.accent};font-size:${palette.ornamentSize}px;line-height:1.4;letter-spacing:5px;">${palette.ornament}</p>
              <p style="margin:0;color:${palette.ink};font-size:13px;line-height:1.6;letter-spacing:1px;">${palette.label}</p>
            </td></tr>
            <tr><td style="padding:30px 24px 14px;">
              <p style="margin:0 0 13px;color:${palette.muted};font-size:14px;line-height:1.7;word-break:break-word;">${escapeHtml(greeting)}</p>
              <h1 style="margin:0 0 16px;color:${palette.ink};font-size:25px;line-height:1.5;font-weight:700;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(input.subject)}</h1>
              <p style="margin:0 0 24px;color:${palette.muted};font-size:15px;line-height:1.85;">${copy.emoji} &nbsp;${escapeHtml(copy.lead)}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;"><tr><td style="padding:19px 18px 5px;border-left:3px solid ${theme.accent};background-color:${palette.header};color:${palette.ink};border-radius:0 12px 12px 0;">${body}</td></tr></table>
            </td></tr>
            <tr><td align="center" style="padding:14px 24px 29px;">${actionHtml}</td></tr>
            <tr><td align="center" style="padding:19px 24px;border-top:1px solid ${palette.border};color:${palette.muted};font-size:13px;line-height:1.8;">${palette.note}<br><span style="font-size:16px;color:${theme.accent};">♡</span></td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:19px 16px 0;color:${palette.muted};font-size:12px;line-height:1.9;">${footer}<br>两个人 · 把日常过成小小的心意</td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  return { html, text: input.body };
}

export function buildMailPreview(theme: string = 'strawberry'): string {
  return renderMail({
    subject: '一份认真完成的小约定，等你验收',
    body: '安安已提交「一起准备周末的野餐」，请来确认完成情况。\n\n完成说明：三明治、草莓和你喜欢的气泡水都准备好啦。\n约定奖励：30 积分\n\n打开两个人：https://couple.example.test/?page=tasks&task=5c30f052-76df-4c1b-b766-6dab9ab7f601',
    kind: 'TASK_SUBMITTED',
    theme,
    appUrl: 'https://couple.example.test',
    recipientName: '小满',
  }).html;
}
