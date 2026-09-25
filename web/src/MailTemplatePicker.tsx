import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  Check,
  Flame,
  Gift,
  LockKeyhole,
  LoaderCircle,
  Mail,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { Button } from './components';
import { api } from './types';

type MailTemplate = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  accent: string;
  background: string;
  html: string;
  /** Number of consecutive days required to unlock this theme. Zero means available by default. */
  unlockDays?: number;
  unlocked?: boolean;
  claimed?: boolean;
};

type MailStreak = {
  current: number;
  best?: number;
  lastCompletedDate?: string | null;
};

type MailMilestone = {
  days: number;
  templateId: string;
  unlocked?: boolean;
  claimed?: boolean;
};

export function MailTemplatePicker({
  currentTheme,
  busy,
  onSave,
  onClaim,
}: {
  currentTheme: string;
  busy: boolean;
  onSave: (theme: string) => Promise<boolean>;
  /** Claiming is separate from saving so the server can permanently record a milestone. */
  onClaim?: (theme: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const [templates, setTemplates] = useState<MailTemplate[] | null>(null);
  const [streak, setStreak] = useState<MailStreak | null>(null);
  const [milestones, setMilestones] = useState<MailMilestone[]>([]);
  const [claimingTheme, setClaimingTheme] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState(currentTheme);
  const [savedTheme, setSavedTheme] = useState(currentTheme);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoadError('');
    setTemplates(null);
    setStreak(null);
    setMilestones([]);
    Promise.allSettled([
      api<{ templates: MailTemplate[] }>('/mail/templates'),
      api<{ streak: MailStreak; milestones: MailMilestone[] }>('/mail/streak'),
    ])
      .then(([templatesResult, streakResult]) => {
        if (!active) return;
        if (templatesResult.status === 'rejected') throw templatesResult.reason;
        const result = templatesResult.value;
        if (!result.templates?.length) throw new Error('暂时没有可选模板，请稍后重试。');
        setTemplates(result.templates);
        if (streakResult.status === 'fulfilled') {
          setStreak(streakResult.value.streak ?? null);
          setMilestones(streakResult.value.milestones ?? []);
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : '模板加载失败，请重试。');
      });
    return () => {
      active = false;
    };
  }, [retry]);

  useEffect(() => {
    setSavedTheme(currentTheme);
    setSelectedTheme(currentTheme);
    setSaveError('');
  }, [currentTheme]);

  const selectedTemplate = templates?.find((template) => template.id === selectedTheme);
  const currentTemplate = templates?.find((template) => template.id === savedTheme);
  const hasChanges = Boolean(selectedTemplate && selectedTheme !== savedTheme);
  const unavailable = busy || saving || Boolean(claimingTheme);
  const milestoneByTemplate = new Map(milestones.map((item) => [item.templateId, item]));
  const templateUnlockDays = (template: MailTemplate) => {
    const value = Number(template.unlockDays ?? milestoneByTemplate.get(template.id)?.days ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const isUnlocked = (template: MailTemplate) =>
    template.unlocked ??
    milestoneByTemplate.get(template.id)?.unlocked ??
    templateUnlockDays(template) === 0;
  const isClaimed = (template: MailTemplate) =>
    template.claimed ??
    milestoneByTemplate.get(template.id)?.claimed ??
    templateUnlockDays(template) === 0;
  const currentStreak = Math.max(0, Math.floor(Number(streak?.current ?? 0)));
  const nextMilestone = templates
    ?.map((template) => ({ template, days: templateUnlockDays(template) }))
    .filter(({ template, days }) => days > 0 && !isUnlocked(template))
    .sort((a, b) => a.days - b.days)[0];
  const progressTarget = nextMilestone?.days ?? 0;
  const progressValue = progressTarget
    ? Math.min(100, Math.round((currentStreak / progressTarget) * 100))
    : 100;

  async function save() {
    if (unavailable || savingRef.current || !hasChanges) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    setSavedMessage('');
    try {
      if (await onSave(selectedTheme)) {
        setSavedTheme(selectedTheme);
        setSavedMessage('已保存，之后的邮件会使用这款模板。');
      } else {
        setSaveError('暂时没能保存，请再试一次。');
      }
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : '暂时没能保存，请再试一次。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function claim(template: MailTemplate) {
    if (unavailable || !isUnlocked(template) || isClaimed(template)) return;
    setClaimingTheme(template.id);
    setSaveError('');
    setSavedMessage('');
    try {
      const success = onClaim
        ? await onClaim(template.id)
        : await api(`/mail/templates/${encodeURIComponent(template.id)}/claim`, 'POST', {}).then(
            () => true,
          );
      if (!success) throw new Error('暂时没能领取，请稍后再试。');
      setTemplates(
        (current) =>
          current?.map((item) =>
            item.id === template.id ? { ...item, claimed: true, unlocked: true } : item,
          ) ?? current,
      );
      setSelectedTheme(template.id);
      setSavedTheme(template.id);
      setSavedMessage(`已领取「${template.name}」，之后的邮件会使用这款模板。`);
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : '暂时没能领取，请稍后再试。');
    } finally {
      setClaimingTheme(null);
    }
  }

  return (
    <section className="mail-template-picker" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>
          <Mail size={19} /> 邮件外观
        </h2>
      </div>
      <p className="account-hint">
        每个人都可以选择自己的信纸。连续完成约定，还会解锁更多可爱的主题。
      </p>

      {streak && (
        <div className="mail-streak-card" aria-label="连续完成进度">
          <div className="mail-streak-icon" aria-hidden="true">
            <Flame size={20} />
          </div>
          <div className="mail-streak-copy">
            <div className="mail-streak-heading">
              <strong>双方连续完成 {currentStreak} 天</strong>
              {streak.best && streak.best > currentStreak ? (
                <small>最长 {streak.best} 天</small>
              ) : null}
            </div>
            <p>
              {nextMilestone
                ? `再坚持 ${Math.max(0, nextMilestone.days - currentStreak)} 天，领取「${nextMilestone.template.name}」`
                : '所有主题都已解锁，继续把日子过成喜欢的样子。'}
            </p>
            <div className="mail-streak-progress" aria-hidden="true">
              <span style={{ width: `${progressValue}%` }} />
            </div>
          </div>
          <Sparkles size={18} className="mail-streak-sparkle" aria-hidden="true" />
        </div>
      )}

      {!templates && !loadError && (
        <div className="mail-template-feedback" role="status">
          <LoaderCircle className="spin" size={18} /> 正在加载邮件模板…
        </div>
      )}

      {loadError && (
        <div className="mail-template-feedback">
          <p role="alert">{loadError}</p>
          <Button
            type="button"
            className="subtle small"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={15} /> 重新加载
          </Button>
        </div>
      )}

      {templates && (
        <>
          <div className="mail-template-grid" role="group" aria-label="选择邮件模板">
            {templates.map((template) => {
              const selected = template.id === selectedTheme;
              const current = template.id === savedTheme;
              const unlockDays = templateUnlockDays(template);
              const unlocked = isUnlocked(template);
              const claimed = isClaimed(template);
              return (
                <button
                  type="button"
                  key={template.id}
                  className={`mail-template-option${selected ? ' is-selected' : ''}${current ? ' is-current' : ''}${!unlocked ? ' is-locked' : ''}`}
                  style={
                    {
                      '--mail-template-accent': template.accent,
                      '--mail-template-background': template.background,
                    } as CSSProperties
                  }
                  aria-pressed={selected}
                  disabled={unavailable || !unlocked}
                  onClick={() => {
                    setSelectedTheme(template.id);
                    setSaveError('');
                    setSavedMessage('');
                  }}
                >
                  <span className="mail-template-swatch" aria-hidden="true">
                    {template.emoji}
                  </span>
                  <span className="mail-template-option-copy">
                    <strong>{template.name}</strong>
                    <small>{template.description}</small>
                  </span>
                  <span className="mail-template-option-status">
                    {!unlocked ? (
                      <>
                        <LockKeyhole size={13} /> 连续 {unlockDays} 天解锁
                      </>
                    ) : current ? (
                      <>
                        <Check size={13} /> 当前使用
                      </>
                    ) : claimed ? (
                      <>
                        <Gift size={13} /> 已领取
                      </>
                    ) : selected ? (
                      '已选 · 待保存'
                    ) : (
                      '点击预览'
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {templates.some(
            (template) =>
              isUnlocked(template) && !isClaimed(template) && templateUnlockDays(template) > 0,
          ) && (
            <div className="mail-template-claims" aria-label="可领取的邮件模板">
              <div>
                <strong>
                  <Gift size={15} /> 有新的主题可以领取
                </strong>
                <span>领取后会自动应用到之后的邮件。</span>
              </div>
              <div className="mail-template-claim-list">
                {templates
                  .filter(
                    (template) =>
                      isUnlocked(template) &&
                      !isClaimed(template) &&
                      templateUnlockDays(template) > 0,
                  )
                  .map((template) => (
                    <Button
                      key={template.id}
                      type="button"
                      className="subtle small"
                      busy={claimingTheme === template.id}
                      disabled={unavailable}
                      onClick={() => void claim(template)}
                    >
                      领取 {template.emoji} {template.name}
                    </Button>
                  ))}
              </div>
            </div>
          )}

          {selectedTemplate ? (
            <div className="mail-template-preview">
              <div className="mail-template-preview-heading">
                <strong>{selectedTemplate.name}</strong>
                <small>邮件示例 · 实际内容会随提醒变化</small>
              </div>
              <iframe
                key={selectedTemplate.id}
                className="mail-template-preview-frame"
                title={`${selectedTemplate.name}邮件预览`}
                srcDoc={selectedTemplate.html}
                sandbox=""
                referrerPolicy="no-referrer"
              />
            </div>
          ) : (
            <p className="account-hint">选择上方任意模板，查看邮件预览。</p>
          )}

          <div className="mail-template-footer">
            <p className="mail-template-save-status" role="status" aria-live="polite">
              {saving
                ? '正在保存你的选择…'
                : hasChanges
                  ? `待保存：${selectedTemplate!.name}`
                  : savedMessage ||
                    (currentTemplate
                      ? `当前使用：${currentTemplate.name}`
                      : '请选择喜欢的邮件模板。')}
            </p>
            <Button
              className="primary"
              type="button"
              busy={saving}
              disabled={busy || !hasChanges}
              onClick={save}
            >
              {saving
                ? '保存中…'
                : hasChanges
                  ? '保存这款模板'
                  : selectedTemplate
                    ? '已使用此模板'
                    : '请先选择模板'}
            </Button>
          </div>
          {saveError && (
            <p className="mail-template-feedback" role="alert">
              {saveError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
