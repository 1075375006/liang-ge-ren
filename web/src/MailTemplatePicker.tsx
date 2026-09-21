import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Check, LoaderCircle, Mail, RefreshCw } from 'lucide-react';
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
};

export function MailTemplatePicker({
  currentTheme,
  busy,
  onSave,
}: {
  currentTheme: string;
  busy: boolean;
  onSave: (theme: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const [templates, setTemplates] = useState<MailTemplate[] | null>(null);
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
    api<{ templates: MailTemplate[] }>('/mail/templates')
      .then((result) => {
        if (!active) return;
        if (!result.templates?.length) throw new Error('暂时没有可选模板，请稍后重试。');
        setTemplates(result.templates);
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
  const unavailable = busy || saving;

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

  return (
    <section className="mail-template-picker" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>
          <Mail size={19} /> 邮件外观
        </h2>
      </div>
      <p className="account-hint">
        选一款喜欢的样式，预览后保存。它只影响发给你的邮件，另一半可以选择自己的样式。
      </p>

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
              return (
                <button
                  type="button"
                  key={template.id}
                  className={`mail-template-option${selected ? ' is-selected' : ''}${current ? ' is-current' : ''}`}
                  style={
                    {
                      '--mail-template-accent': template.accent,
                      '--mail-template-background': template.background,
                    } as CSSProperties
                  }
                  aria-pressed={selected}
                  disabled={unavailable}
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
                    {current ? (
                      <>
                        <Check size={13} /> 当前使用
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
